import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  lstatSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  chmodSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { RowSelection } from '../storage-state/search-index.ts';
import { indexedIds } from './search-index.ts';

import { StateStorage, emptyState, type State, type RecordRow } from '../storage-state/index.ts';
import {
  StoreUnavailableError,
  StoreBusyError,
  StoreVersionTooNewError,
  ValidationFailedError,
  MemoryKitError,
  sha256Hex,
} from '../model/index.ts';
function markdown(record: RecordRow): string {
  const { content, ...header } = record;
  return `---\n${JSON.stringify(header)}\n---\n${content}`;
}
function durable(file: string, data: string): void {
  const fd = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Local, managed Markdown records with an atomic manifest. Not a Markdown editor sync engine. */
export class MarkdownStorage extends StateStorage {
  readonly descriptor = {
    id: 'storage-markdown',
    version: '0.2.0',
    contractVersions: [1],
    capabilities: ['search.lexical', 'retrieve.lexical', 'purge.current'],
    limitations: [
      'local-filesystem-only',
      'linear-manifest-and-writes',
      'managed-markdown',
      'manual-crash-lock-recovery',
    ],
  };
  private readonly path: string;
  private readonly timeout: number;
  private opened = false;
  private readonly searchIndex: boolean;
  constructor(options: { path: string; busyTimeoutMs?: number; searchIndex?: boolean }) {
    super();
    this.path = resolve(options.path);
    this.timeout = options.busyTimeoutMs ?? 5000;
    this.searchIndex = options.searchIndex === true;
    if (options.searchIndex !== undefined && typeof options.searchIndex !== 'boolean')
      throw new ValidationFailedError('searchIndex must be boolean');
    if (!this.searchIndex) this.descriptor.limitations.push('linear-search');
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 0 || this.timeout > 120000)
      throw new ValidationFailedError('busyTimeoutMs must be an integer between 0 and 120000');
    if (options.path.startsWith('\\\\') || options.path.startsWith('//'))
      throw new StoreUnavailableError('Local filesystem required', { reason: 'network_path' });
  }
  private async lock<T>(fn: () => Promise<T>): Promise<T> {
    const lock = join(this.path, '.lock');
    const started = Date.now();
    for (;;) {
      try {
        mkdirSync(lock);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (Date.now() - started >= this.timeout)
          throw new StoreBusyError('The Markdown store is locked', { timeoutMs: this.timeout });
        await setTimeout(10);
      }
    }
    try {
      return await fn();
    } finally {
      rmSync(lock, { recursive: true });
    }
  }
  async open(): Promise<void> {
    if (this.opened) return;
    mkdirSync(this.path, { recursive: true });
    await this.lock(async () => {
      if (!existsSync(join(this.path, 'state.json'))) {
        if (readdirSync(this.path).some((f) => f !== '.lock'))
          throw new StoreUnavailableError('Directory is not an empty Markdown store', {
            reason: 'not_a_store',
          });
        mkdirSync(join(this.path, 'records'));
        durable(join(this.path, 'state.json'), JSON.stringify(emptyState()));
      }
      const { state } = this.load();
      this.collect(state);
    });
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  private load(ids?: string[]): { state: State; rows: RecordRow[] } {
    try {
      const state = JSON.parse(readFileSync(join(this.path, 'state.json'), 'utf8')) as State;
      if (state.version > 1)
        throw new StoreVersionTooNewError('Markdown schema is newer than this MemoryKit', {
          found: state.version,
          supported: 1,
        });
      if (
        state.version !== 1 ||
        !Array.isArray(state.operations) ||
        !Array.isArray(state.outbox) ||
        !state.files
      )
        throw new Error('manifest');
      const rows = (ids === undefined ? Object.keys(state.files) : ids.filter((id) => Object.hasOwn(state.files,id))).map((id) => {
        const file = state.files[id]!;
        if (!/^[a-f0-9]{64}\.md$/.test(file)) throw new Error('filename');
        const path = join(this.path, 'records', file);
        if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('file');
        const text = readFileSync(path, 'utf8');
        if (sha256Hex(text) + '.md' !== file) throw new Error('edited');
        const end = text.indexOf('\n---\n', 4);
        const header = JSON.parse(text.slice(4, end)) as Omit<RecordRow, 'content'>;
        if (!text.startsWith('---\n') || end < 0 || header.id !== id) throw new Error('header');
        return { ...header, content: text.slice(end + 5) };
      });
      return { state, rows };
    } catch (e) {
      if (e instanceof MemoryKitError) throw e;
      throw new StoreUnavailableError('Markdown store is corrupt or was edited outside MemoryKit', {
        reason: 'integrity_failed',
      });
    }
  }
  protected async readRows<T>(selection: RowSelection, fn: (rows: RecordRow[]) => T): Promise<T> {
    if (!this.searchIndex) return super.readRows(selection, fn);
    if (!this.opened) throw new StoreUnavailableError('Store is closed', { reason: 'closed' });
    return this.lock(async () => {
      const { state } = this.load([]);
      const path = join(this.path, 'search.sqlite');
      for (const file of [path, path + '-journal']) {
        if (existsSync(file) && lstatSync(file).isSymbolicLink()) rmSync(file);
      }
      const read = (ids: string[]) => this.load(ids).rows;
      const lookup = () => indexedIds(path, state, selection, read);
      let ids: string[];
      try { ids = lookup(); }
      catch (error) {
        // Authoritative integrity errors must never be hidden by rebuilding derived data.
        if (error instanceof MemoryKitError) throw error;
        rmSync(path, { force: true });
        rmSync(path + '-journal', { force: true });
        ids = lookup();
      }
      chmodSync(path, 0o600);
      return structuredClone(fn(read(ids)));
    });
  }
  private collect(state: State): void {
    const keep = new Set(Object.values(state.files));
    for (const file of readdirSync(join(this.path, 'records'))) {
      if (/^[a-f0-9]{64}\.md$/.test(file) && !keep.has(file))
        rmSync(join(this.path, 'records', file));
    }
    for (const file of readdirSync(this.path))
      if (/^state-[a-f0-9]+\.tmp$/.test(file)) rmSync(join(this.path, file));
  }
  private save(state: State, rows: RecordRow[]): void {
    state.files = {};
    for (const row of rows) {
      const text = markdown(row);
      const file = sha256Hex(text) + '.md';
      state.files[row.id] = file;
      if (!existsSync(join(this.path, 'records', file)))
        durable(join(this.path, 'records', file), text);
    }
    const tmp = join(this.path, `state-${randomBytes(12).toString('hex')}.tmp`);
    durable(tmp, JSON.stringify(state));
    // Invalidate before publishing a write, including when this writer has indexing disabled.
    // A crash leaves a rebuildable missing index, never retained terms from a completed purge.
    rmSync(join(this.path, 'search.sqlite'), { force: true });
    rmSync(join(this.path, 'search.sqlite-journal'), { force: true });
    renameSync(tmp, join(this.path, 'state.json'));
    this.collect(state);
  }
  protected async use<T>(
    change: boolean,
    fn: (state: State, rows: RecordRow[]) => T | Promise<T>
  ): Promise<T> {
    if (!this.opened) throw new StoreUnavailableError('Store is closed', { reason: 'closed' });
    return this.lock(async () => {
      const { state, rows } = this.load();
      const result = await fn(state, rows);
      if (change) this.save(state, rows);
      return structuredClone(result);
    });
  }
}
