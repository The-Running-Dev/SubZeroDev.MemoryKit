import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import {
  isPlainObject,
  parseNamespace,
  sha256Hex,
  toProblem,
  ValidationFailedError,
  type JsonValue,
} from '../model/index.ts';
import type { CreateInput, MemoryClient } from '../service/index.ts';
import { fields, integer, nonempty } from './index.ts';

// A Git repository as a read-only memory source. Only committed objects are read, through
// plumbing commands: no checkout, hooks, textconv or filter drivers run, and nothing in the
// repository is written. S27 imports one committed tree; syncing later commits is S28.

export type NamespaceMapping =
  | string
  | {
      by: 'first-segment' | 'front-matter';
      field?: string;
      map: Record<string, string>;
      default?: string;
    };

export interface GitSourceConfig {
  id: string;
  repository: string;
  ref: string;
  include: string[];
  exclude?: string[];
  namespace: NamespaceMapping;
  status?: 'candidate' | 'accepted';
  chunkBytes?: number;
  extensions?: string[];
  kinds?: Record<string, string>;
}

export type SkipReason =
  'type' | 'size' | 'secret' | 'unmapped' | 'front-matter' | 'sections' | 'encoding' | 'path';

export interface GitSourceSkip {
  path: string;
  reason: SkipReason;
  rule?: string;
  bytes?: number;
}

export interface PlannedGitRecord {
  input: CreateInput;
  operationId: string;
  path: string;
  bytes: number;
}

export interface GitSourcePlan {
  source: string;
  commit: string;
  records: PlannedGitRecord[];
  skipped: GitSourceSkip[];
  counts: {
    files: number;
    records: number;
    chunkedFiles: number;
    skipped: number;
    excluded: number;
    notIncluded: number;
  };
}

export interface GitSourceSyncResult {
  source: string;
  commit: string;
  created: number;
  unchanged: number;
  failures: { key: string; code: string }[];
  skipped: GitSourceSkip[];
  counts: GitSourcePlan['counts'];
  completeness: 'complete' | 'partial';
}

export const MAX_GIT_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_GIT_SECTIONS = 256;
export const DEFAULT_CHUNK_BYTES = 32768;
const MAX_FRONT_MATTER_BYTES = 4096;
const FRONT_MATTER_FIELDS = ['title', 'date', 'type', 'tags', 'project', 'record-kind'];
const DEFAULT_EXTENSIONS = ['.md', '.markdown', '.txt'];
const DEFAULT_EXCLUDES = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_*',
  '**/*.p12',
  '**/*.pfx',
];
const SECRET_RULES: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ['api-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{32,}\b/],
];

export function validateGitSource(value: unknown): GitSourceConfig {
  fields(
    value,
    [
      'id',
      'repository',
      'ref',
      'include',
      'exclude',
      'namespace',
      'status',
      'chunkBytes',
      'extensions',
      'kinds',
    ],
    ['id', 'repository', 'ref', 'include', 'namespace']
  );
  nonempty(value.id, 'source id', 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.id))
    throw new ValidationFailedError('Invalid source id');
  nonempty(value.repository, 'source repository', 1024);
  if (!isAbsolute(value.repository))
    throw new ValidationFailedError('Source repository needs an absolute path');
  nonempty(value.ref, 'source ref', 256);
  if (value.ref.startsWith('-')) throw new ValidationFailedError('Invalid source ref');
  for (const key of ['include', 'exclude'] as const) {
    const list = value[key];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 64 || (key === 'include' && list.length === 0))
      throw new ValidationFailedError(`Invalid source ${key}`);
    list.forEach((glob) => nonempty(glob, `source ${key} pattern`, 256));
  }
  if (value.status !== undefined && !['candidate', 'accepted'].includes(value.status as string))
    throw new ValidationFailedError('Invalid source status');
  integer(value.chunkBytes, 'chunkBytes', DEFAULT_CHUNK_BYTES, 1024, 262144);
  if (value.extensions !== undefined) {
    if (!Array.isArray(value.extensions) || value.extensions.length > 16)
      throw new ValidationFailedError('Invalid source extensions');
    for (const ext of value.extensions)
      if (typeof ext !== 'string' || !/^\.[A-Za-z0-9]{1,16}$/.test(ext))
        throw new ValidationFailedError('Invalid source extensions');
  }
  if (value.kinds !== undefined) {
    if (!isPlainObject(value.kinds)) throw new ValidationFailedError('Invalid source kinds');
    for (const kind of Object.values(value.kinds)) nonempty(kind, 'source kind', 128);
  }
  const ns = value.namespace;
  if (typeof ns === 'string') parseNamespace(ns);
  else {
    fields(ns, ['by', 'field', 'map', 'default'], ['by', 'map']);
    if (!['first-segment', 'front-matter'].includes(ns.by as string))
      throw new ValidationFailedError('Invalid namespace mapping');
    if (ns.by === 'front-matter' && !FRONT_MATTER_FIELDS.includes(ns.field as string))
      throw new ValidationFailedError('Namespace mapping needs an allowed front-matter field');
    if (!isPlainObject(ns.map)) throw new ValidationFailedError('Invalid namespace mapping');
    Object.values(ns.map).forEach((target) => parseNamespace(target as string));
    if (ns.default !== undefined) parseNamespace(ns.default as string);
  }
  return value as unknown as GitSourceConfig;
}

function globRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          out += '(?:.*/)?';
        } else out += '.*';
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function git(repository: string, args: string[], maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', repository, ...args],
    {
      maxBuffer,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }
  );
  if (result.error || result.status !== 0)
    throw new ValidationFailedError('Git source read failed', {
      command: args[0] ?? 'git',
    });
  return result.stdout;
}

interface TreeEntry {
  mode: string;
  type: string;
  blob: string;
  size: number;
  path: string;
}

function readTree(repository: string, commit: string): TreeEntry[] {
  const out = git(repository, ['ls-tree', '-r', '-z', '-l', '--full-tree', commit]).toString(
    'utf8'
  );
  const entries: TreeEntry[] = [];
  for (const row of out.split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t');
    const [mode, type, blob, size] = row.slice(0, tab).split(/\s+/);
    entries.push({
      mode: mode!,
      type: type!,
      blob: blob!,
      size: size === '-' ? 0 : Number(size),
      path: row.slice(tab + 1),
    });
  }
  return entries;
}

interface FrontMatter {
  fields: Record<string, JsonValue>;
  body: string;
}

function scalar(raw: string): string {
  const text = raw.trim();
  const quote = text[0];
  if ((quote === '"' || quote === "'") && text.endsWith(quote) && text.length >= 2)
    return text.slice(1, -1);
  return text;
}

// A bounded YAML subset: scalar values, inline lists and dash lists. Anything else fails.
export function parseFrontMatter(text: string): FrontMatter | null | 'invalid' {
  if (!/^---\r?\n/.test(text)) return null;
  const rest = text.replace(/^---\r?\n/, '');
  const end = rest.search(/^---[ \t]*\r?$/m);
  if (end < 0 || Buffer.byteLength(rest.slice(0, end)) > MAX_FRONT_MATTER_BYTES) return 'invalid';
  const block = rest.slice(0, end);
  const after = rest.slice(end).replace(/^---[ \t]*\r?(?:\n|$)/, '');
  const result: Record<string, JsonValue> = {};
  let listKey: string | null = null;
  for (const line of block.split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey !== null) {
      (result[listKey] as string[]).push(scalar(item[1]!));
      continue;
    }
    const pair = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!pair) return 'invalid';
    const [, key, value] = pair as unknown as [string, string, string];
    listKey = null;
    if (value === '') {
      if (FRONT_MATTER_FIELDS.includes(key)) {
        result[key] = [];
        listKey = key;
      }
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const items = value
        .slice(1, -1)
        .split(',')
        .map((v) => scalar(v))
        .filter((v) => v !== '');
      if (FRONT_MATTER_FIELDS.includes(key)) result[key] = items;
    } else if (value.startsWith('[') || value.startsWith('{') || /^[|>&*!]/.test(value)) {
      return 'invalid';
    } else if (FRONT_MATTER_FIELDS.includes(key)) {
      result[key] = scalar(value);
    }
  }
  // Allowlisted fields only, with an empty dash list dropped.
  for (const key of Object.keys(result))
    if (Array.isArray(result[key]) && (result[key] as string[]).length === 0) delete result[key];
  return { fields: result, body: after };
}

function utf8Prefix(text: string, bytes: number): number {
  // Largest character count whose UTF-8 encoding fits in `bytes`, never splitting a pair.
  let used = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i)!;
    const size = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (used + size > bytes) break;
    used += size;
    i += cp > 0xffff ? 2 : 1;
  }
  return i;
}

function splitAtHeadings(text: string, level: number): string[] {
  const marker = new RegExp(`^#{${level}}[ \\t]`);
  const lines = text.split(/(?<=\n)/);
  const sections: string[] = [];
  let current = '';
  let fenced = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (!fenced && marker.test(line) && current !== '') {
      sections.push(current);
      current = '';
    }
    current += line;
  }
  if (current !== '') sections.push(current);
  return sections;
}

function splitText(text: string, limit: number, level = 1): string[] {
  if (Buffer.byteLength(text) <= limit) return [text];
  for (let l = level; l <= 6; l++) {
    const sections = splitAtHeadings(text, l);
    if (sections.length > 1) return sections.flatMap((section) => splitText(section, limit, l + 1));
  }
  // No headings left: paragraphs, then lines, then raw characters.
  const parts: string[] = [];
  for (const paragraph of text.split(/(?<=\n\n)/)) {
    if (Buffer.byteLength(paragraph) <= limit) parts.push(paragraph);
    else
      for (const line of paragraph.split(/(?<=\n)/)) {
        let rest = line;
        while (Buffer.byteLength(rest) > limit) {
          const cut = utf8Prefix(rest, limit);
          parts.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        if (rest) parts.push(rest);
      }
  }
  return parts;
}

// Ordered sections, each within the limit, whose concatenation equals the text.
export function chunkText(text: string, limit: number): string[] {
  const pieces = splitText(text, limit);
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current !== '' && Buffer.byteLength(current) + Buffer.byteLength(piece) > limit) {
      chunks.push(current);
      current = '';
    }
    current += piece;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

function slug(text: string): string {
  const heading = /^#{1,6}[ \t]+(.+)$/m.exec(text)?.[1] ?? '';
  return (
    heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'section'
  );
}

function resolveNamespace(
  mapping: NamespaceMapping,
  path: string,
  front: Record<string, JsonValue>
): string | undefined {
  if (typeof mapping === 'string') return mapping;
  const key =
    mapping.by === 'first-segment'
      ? path.includes('/')
        ? path.slice(0, path.indexOf('/'))
        : undefined
      : (front[mapping.field!] as string | undefined);
  if (typeof key === 'string' && Object.hasOwn(mapping.map, key)) return mapping.map[key];
  return mapping.default;
}

export function planGitSource(config: GitSourceConfig): GitSourcePlan {
  const source = validateGitSource(config);
  const chunkBytes = integer(source.chunkBytes, 'chunkBytes', DEFAULT_CHUNK_BYTES, 1024, 262144);
  const commit = git(source.repository, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${source.ref}^{commit}`,
  ])
    .toString('utf8')
    .trim();
  const meta = git(source.repository, ['show', '-s', '--format=%an%x00%aI', commit])
    .toString('utf8')
    .trim()
    .split('\0');
  const include = source.include.map(globRegExp);
  const exclude = [...(source.exclude ?? []), ...DEFAULT_EXCLUDES].map(globRegExp);
  const extensions = source.extensions ?? DEFAULT_EXTENSIONS;
  const plan: GitSourcePlan = {
    source: source.id,
    commit,
    records: [],
    skipped: [],
    counts: { files: 0, records: 0, chunkedFiles: 0, skipped: 0, excluded: 0, notIncluded: 0 },
  };
  const skip = (path: string, reason: SkipReason, extra: Partial<GitSourceSkip> = {}) =>
    plan.skipped.push({ path, reason, ...extra });
  const entries = readTree(source.repository, commit).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0
  );
  for (const entry of entries) {
    if (!include.some((re) => re.test(entry.path))) {
      plan.counts.notIncluded++;
      continue;
    }
    // Excluded paths are counted only: their names never reach a record, plan or report.
    if (exclude.some((re) => re.test(entry.path))) {
      plan.counts.excluded++;
      continue;
    }
    plan.counts.files++;
    const extension = /\.[^./]+$/.exec(entry.path)?.[0]?.toLowerCase() ?? '';
    if (entry.type !== 'blob' || entry.mode === '120000' || !extensions.includes(extension)) {
      skip(entry.path, 'type');
      continue;
    }
    if (entry.size > MAX_GIT_FILE_BYTES) {
      skip(entry.path, 'size', { bytes: entry.size });
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        git(source.repository, ['cat-file', 'blob', entry.blob], MAX_GIT_FILE_BYTES + 1024)
      );
    } catch {
      skip(entry.path, 'encoding');
      continue;
    }
    if (text.includes('\0')) {
      skip(entry.path, 'encoding');
      continue;
    }
    const rule = SECRET_RULES.find(([, re]) => re.test(text))?.[0];
    if (rule) {
      skip(entry.path, 'secret', { rule });
      continue;
    }
    const front = parseFrontMatter(text);
    if (front === 'invalid') {
      skip(entry.path, 'front-matter');
      continue;
    }
    const frontFields = front?.fields ?? {};
    const namespace = resolveNamespace(source.namespace, entry.path, frontFields);
    if (namespace === undefined) {
      skip(entry.path, 'unmapped');
      continue;
    }
    const chunks = chunkText(text, chunkBytes);
    if (chunks.length > MAX_GIT_SECTIONS) {
      skip(entry.path, 'sections');
      continue;
    }
    const type = typeof frontFields.type === 'string' ? frontFields.type : undefined;
    const kind = (type !== undefined && source.kinds?.[type]) || 'document';
    const contentSha256 = sha256Hex(text);
    const markdown = extension === '.md' || extension === '.markdown';
    if (chunks.length > 1) plan.counts.chunkedFiles++;
    let skippedPath = false;
    const records: PlannedGitRecord[] = [];
    chunks.forEach((chunk, index) => {
      const chunked = chunks.length > 1;
      const section = chunked ? `${String(index + 1).padStart(3, '0')}-${slug(chunk)}` : undefined;
      const key = `git:${source.id}:${entry.path}${section ? `#${section}` : ''}`;
      if (key.length > 512 || entry.path.length > 400) {
        skippedPath = true;
        return;
      }
      const sourceMeta: Record<string, JsonValue> = {
        kind: 'git',
        id: source.id,
        commit,
        path: entry.path,
        blob: entry.blob,
        contentSha256,
        author: meta[0] ?? '',
        authoredAt: meta[1] ?? '',
      };
      if (chunked) sourceMeta.section = { ordinal: index + 1, count: chunks.length, id: section! };
      records.push({
        path: entry.path,
        bytes: Buffer.byteLength(chunk),
        operationId: `gitsrc:${sha256Hex(`${source.id}\0${commit}\0${entry.path}\0${section ?? ''}`).slice(0, 48)}`,
        input: {
          namespace,
          key,
          kind,
          content: chunk,
          contentType: markdown ? 'text/markdown' : 'text/plain',
          metadata: {
            status: source.status ?? 'candidate',
            gitSource: source.id,
            ...(Object.keys(frontFields).length ? { frontmatter: frontFields } : {}),
            source: sourceMeta,
          },
          provenance: {
            origin: { kind: 'git-source', name: source.id, version: commit },
            reason: 'Imported from a committed Git tree',
            evidence: [
              { ref: `git:${source.id}@${commit}:${entry.path}`, note: `blob ${entry.blob}` },
            ],
          },
        },
      });
    });
    if (skippedPath) {
      skip(entry.path, 'path');
      continue;
    }
    plan.records.push(...records);
  }
  plan.counts.records = plan.records.length;
  plan.counts.skipped = plan.skipped.length;
  return plan;
}

// The operation id is derived from source, commit, path and section, so replaying a sync
// resumes an interrupted import and a repeat at the same commit writes nothing.
export async function syncGitSource(
  client: MemoryClient,
  config: GitSourceConfig
): Promise<GitSourceSyncResult> {
  const plan = planGitSource(config);
  const result: GitSourceSyncResult = {
    source: plan.source,
    commit: plan.commit,
    created: 0,
    unchanged: 0,
    failures: [],
    skipped: plan.skipped,
    counts: plan.counts,
    completeness: 'complete',
  };
  for (const record of plan.records) {
    try {
      const known = await client.operation(record.operationId).then(
        () => true,
        (error: unknown) => {
          if (toProblem(error).code === 'NotFound') return false;
          throw error;
        }
      );
      if (known) {
        result.unchanged++;
        continue;
      }
      await client.create(record.input, { operationId: record.operationId });
      result.created++;
    } catch (error) {
      result.failures.push({ key: record.input.key!, code: toProblem(error).code });
      result.completeness = 'partial';
    }
  }
  return result;
}
