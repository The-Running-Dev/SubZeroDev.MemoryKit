// Optional, user-configured processes. This infrastructure is never selected from stored
// memories or tool arguments. No shell, no model SDK, no inherited stdout/stderr protocol.
import { spawn } from 'node:child_process';
import { isPlainObject, StoreUnavailableError, ValidationFailedError } from '../model/index.ts';
import type { CaptureInput, Distiller, EmbeddingProvider, Observation } from '../workflow/index.ts';

export interface CommandProviderOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export function commandJson(options: CommandProviderOptions, request: unknown): Promise<unknown> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const maxOutputBytes = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (
    typeof options.command !== 'string' ||
    options.command === '' ||
    (options.args !== undefined &&
      (!Array.isArray(options.args) || options.args.some((arg) => typeof arg !== 'string'))) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 120000 ||
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 16 * 1024 * 1024
  ) {
    throw new ValidationFailedError('Invalid command provider configuration');
  }
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > 8 * 1024 * 1024)
    throw new ValidationFailedError('Command provider input exceeds 8 MiB');
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, options.args ?? [], {
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) {
        child.kill();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new StoreUnavailableError('Command provider timed out')),
      timeoutMs
    );
    child.on('error', () => finish(new StoreUnavailableError('Command provider could not start')));
    child.stdin.on('error', () =>
      finish(new StoreUnavailableError('Command provider input failed'))
    );
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxOutputBytes)
        finish(new StoreUnavailableError('Command provider output limit exceeded'));
      else chunks.push(chunk);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        finish(new StoreUnavailableError('Command provider failed'));
        return;
      }
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        finish(new StoreUnavailableError('Command provider returned invalid JSON'));
      }
    });
    child.stdin.end(input);
  });
}
export class CommandDistiller implements Distiller {
  readonly options: CommandProviderOptions;
  constructor(options: CommandProviderOptions) {
    this.options = options;
  }
  async distill(input: CaptureInput): Promise<Observation[]> {
    const result = await commandJson(this.options, { version: 1, task: 'distill', input });
    if (!isPlainObject(result) || !Array.isArray(result.observations))
      throw new ValidationFailedError('Distiller must return observations');
    return result.observations as Observation[]; // The workflow validates every field before writes.
  }
}
export class CommandEmbeddings implements EmbeddingProvider {
  readonly options: CommandProviderOptions;
  readonly id: string;
  constructor(id: string, options: CommandProviderOptions) {
    this.id = id;
    this.options = options;
  }
  async embed(texts: string[], role: 'query' | 'document'): Promise<number[][]> {
    const result = await commandJson(this.options, { version: 1, task: 'embed', role, texts });
    if (!isPlainObject(result) || !Array.isArray(result.vectors))
      throw new ValidationFailedError('Embedder must return vectors');
    return result.vectors as number[][];
  }
}
