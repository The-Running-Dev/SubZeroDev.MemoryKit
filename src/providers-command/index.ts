// Optional, user-configured processes. This infrastructure is never selected from stored
// memories or tool arguments. No shell, no model SDK, no inherited stdout/stderr protocol.
import { spawn } from 'node:child_process';
import { isPlainObject, StoreUnavailableError, ValidationFailedError } from '../model/index.ts';
import type {
  CaptureInput,
  Distiller,
  EmbeddingProvider,
  Observation,
  RecallRequest,
  RecallSelection,
  RecallSelector,
} from '../workflow/index.ts';

export interface CommandProviderOptions {
  command: string;
  args?: string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export function commandJson(options: CommandProviderOptions, request: unknown, signal?: AbortSignal): Promise<unknown> {
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
    if (signal?.aborted) {
      reject(new StoreUnavailableError('Recall deadline exceeded', { reason: 'deadline' }));
      return;
    }
    const child = spawn(options.command, options.args ?? [], {
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const finish = (error?: Error, result?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) {
        // On Windows the adapter may own a native model CLI. Kill its process tree
        // before the parent disappears, so the total deadline also stops descendants.
        if (process.platform === 'win32' && child.pid) {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            shell: false, windowsHide: true, stdio: 'ignore',
          });
          killer.on('error', () => child.kill());
        } else if (child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); }
        } else child.kill();
        reject(error);
      } else resolve(result);
    };
    const timer = setTimeout(
      () => finish(new StoreUnavailableError('Command provider timed out', { reason: 'timeout' })),
      timeoutMs
    );
    const abort = () => finish(new StoreUnavailableError('Recall deadline exceeded', { reason: 'deadline' }));
    signal?.addEventListener('abort', abort, { once: true });
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
        finish(
          new StoreUnavailableError(
            'Command provider failed',
            code === 75 ? { reason: 'timeout' } : {}
          )
        );
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
export class CommandRecallSelector implements RecallSelector {
  attempts = 0;
  readonly id: string;
  readonly options: CommandProviderOptions;
  readonly expand?: (query: string, signal?: AbortSignal) => Promise<string[]>;
  readonly budget: RecallSelector['budget'];
  readonly verify?: (
    input: RecallRequest,
    selections: RecallSelection[],
    signal?: AbortSignal
  ) => Promise<RecallSelection[]>;
  constructor(
    id: string,
    options: CommandProviderOptions,
    discovery = false,
    verification = false,
    retries = 0,
    budget?: RecallSelector['budget']
  ) {
    this.id = id;
    this.options = options;
    this.budget = budget;
    if (!Number.isInteger(retries) || retries < 0 || retries > 1)
      throw new ValidationFailedError('Recall retries must be 0 or 1');
    const invoke = async (request: unknown, signal?: AbortSignal) => {
      for (let attempt = 0; ; attempt++) {
        try {
          this.attempts++;
          return await commandJson(this.options, request, signal);
        } catch (error) {
          if (
            attempt >= retries ||
            !(error instanceof StoreUnavailableError) ||
            error.details.reason !== 'timeout'
          )
            throw error;
        }
      }
    };
    this.invoke = invoke;
    if (verification)
      this.verify = async (input, selections, signal) => {
        const result = await invoke({
          version: 1,
          task: 'verify',
          ...input,
          selections,
        }, signal);
        if (!isPlainObject(result) || !Array.isArray(result.selections))
          throw new ValidationFailedError('Recall verifier must return selections');
        return result.selections as RecallSelection[];
      };
    if (discovery)
      this.expand = async (query, signal) => {
        const result = await invoke({ version: 1, task: 'expand', query }, signal);
        if (!isPlainObject(result) || !Array.isArray(result.queries))
          throw new ValidationFailedError('Recall discovery must return queries');
        return result.queries as string[];
      };
  }
  private readonly invoke: (request: unknown, signal?: AbortSignal) => Promise<unknown>;
  async select(input: RecallRequest, signal?: AbortSignal): Promise<RecallSelection[]> {
    const result = await this.invoke({ version: 1, task: 'select', ...input }, signal);
    if (!isPlainObject(result) || !Array.isArray(result.selections))
      throw new ValidationFailedError('Recall selector must return selections');
    return result.selections as RecallSelection[];
  }
}
