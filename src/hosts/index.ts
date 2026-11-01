import { execFileSync } from 'node:child_process';
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { isPlainObject, parseNamespace, sha256Hex, ValidationFailedError } from '../model/index.ts';
import { type CaptureInput, type Observation } from '../workflow/index.ts';

export type Host = 'claude-code' | 'codex';
export interface HookEvent {
  hook_event_name: 'SessionStart' | 'Stop' | 'PreCompact';
  cwd: string;
  session_id?: string;
  transcript_path?: string;
  stop_hook_active?: boolean;
}
export function parseHookEvent(raw: string): HookEvent {
  let value: unknown;
  try {
    value = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    throw new ValidationFailedError('Hook input must be JSON');
  }
  if (
    !isPlainObject(value) ||
    typeof value.cwd !== 'string' ||
    !isAbsolute(value.cwd) ||
    !['SessionStart', 'Stop', 'PreCompact'].includes(value.hook_event_name as string) ||
    (value.session_id !== undefined && typeof value.session_id !== 'string') ||
    (value.transcript_path !== undefined &&
      (typeof value.transcript_path !== 'string' || !isAbsolute(value.transcript_path))) ||
    (value.stop_hook_active !== undefined && typeof value.stop_hook_active !== 'boolean')
  ) {
    throw new ValidationFailedError('Invalid hook event');
  }
  return value as unknown as HookEvent;
}

export function projectNamespace(cwd: string): string {
  let origin: string;
  try {
    origin = execFileSync('git', ['-C', cwd, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    throw new ValidationFailedError(
      'No Git origin; configure an explicit namespace for this project'
    );
  }
  let path: string;
  try {
    const remote = new URL(origin);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(remote.protocol) || !remote.hostname) {
      throw new Error('Unsupported remote');
    }
    path = remote.pathname;
  } catch {
    const scp = /^[^/@\s]+@[^/:\s]+:(.+)$/.exec(origin);
    if (!scp)
      throw new ValidationFailedError('Unsupported Git origin; configure an explicit namespace');
    path = scp[1]!;
  }
  const segments = path
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '')
    .split('/');
  if (segments.length < 2)
    throw new ValidationFailedError(
      'Git origin needs owner and repository; configure an explicit namespace'
    );
  return parseNamespace('project/' + segments.slice(-2).join('/').toLowerCase());
}

function clip(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  return (
    Buffer.from(text, 'utf8')
      .subarray(0, maxBytes)
      .toString('utf8')
      .replace(/\uFFFD$/, '') + '\n[truncated]'
  );
}

export interface TranscriptCapture {
  input: CaptureInput | null;
  truncated: boolean;
  skipped: number;
}
export function readTranscript(host: Host, event: HookEvent, namespace: string): TranscriptCapture {
  if (!event.session_id || !event.transcript_path)
    throw new ValidationFailedError('Capture hook needs session_id and transcript_path');
  const fd = openSync(event.transcript_path, 'r');
  let data: Buffer, start: number;
  try {
    const size = fstatSync(fd).size;
    start = Math.max(0, size - 2 * 1024 * 1024);
    data = Buffer.alloc(size - start);
    const read = readSync(fd, data, 0, data.length, start);
    data = data.subarray(0, read);
  } finally {
    closeSync(fd);
  }
  const source: CaptureInput['source'] = {
    host,
    sessionId: event.session_id,
    eventId: 'transcript',
    ref: 'file:' + event.transcript_path,
  };
  let offset = start,
    skipped = 0,
    clipped = false;
  const observations: Observation[] = [];
  // A bounded tail can start inside a code point or JSON line; never interpret that fragment.
  if (start > 0) {
    const end = data.indexOf(10);
    if (end === -1) return { input: null, truncated: true, skipped: 1 };
    offset += end + 1;
    data = data.subarray(end + 1);
  }
  let lineStart = 0;
  for (let end = 0; end <= data.length; end++) {
    if (end < data.length && data[end] !== 10) continue;
    const line = data.subarray(lineStart, end).toString('utf8');
    const position = offset;
    offset += end - lineStart + 1;
    lineStart = end + 1;
    if (line.trim() === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (!isPlainObject(row) || row.isSidechain === true) continue;
    let message: Record<string, unknown> | undefined;
    if (
      host === 'claude-code' &&
      ['user', 'assistant'].includes(row.type as string) &&
      isPlainObject(row.message)
    )
      message = row.message;
    if (
      host === 'codex' &&
      row.type === 'response_item' &&
      isPlainObject(row.payload) &&
      row.payload.type === 'message'
    )
      message = row.payload;
    if (!message || !['user', 'assistant'].includes(message.role as string)) continue;
    const content =
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content
              .filter(
                (part) =>
                  isPlainObject(part) &&
                  ['text', 'input_text', 'output_text'].includes(part.type as string) &&
                  typeof part.text === 'string'
              )
              .map((part: Record<string, unknown>) => part.text as string)
              .join('\n')
          : '';
    if (!content.trim()) continue;
    if (/<private\b|<memorykit-context\b/i.test(content)) {
      skipped++;
      continue;
    }
    const identity = typeof row.uuid === 'string' ? row.uuid : String(position);
    if (Buffer.byteLength(content, 'utf8') > 8192) clipped = true;
    observations.push({
      id: sha256Hex(identity),
      role: message.role as 'user' | 'assistant',
      content: clip(content, 8192),
    });
  }
  const truncated = start > 0 || observations.length > 100 || clipped;
  const selected = observations.slice(-100);
  return {
    input: selected.length === 0 ? null : { namespace, source, observations: selected },
    truncated,
    skipped,
  };
}
