import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HistoryProviderError,
  type BoundaryResult,
  type HistoryBoundary,
  type HistoryEntry,
  type HistoryProvider,
  type ProviderDescriptor,
  type RedactedRecord,
  type RevisionSnapshot,
  type RevisionSummary,
} from '../contracts/index.ts';
import {
  InternalError,
  UnsupportedContractVersionError,
  type ContentType,
  type MemoryId,
  type MemoryRecord,
  type Namespace,
  type Operation,
} from '../model/index.ts';
import { RevisionIndex, type IndexEntry } from './revision-index.ts';

export interface GitHistoryOptions {
  repository: string;
  branch?: string;
  gitPath?: string;
  author?: { name: string; email: string };
}

const FORMAT = '1';
const FORMAT_PATH = '.memorykit/format';
const CAS_ATTEMPTS = 8;
const EXTENSIONS: Record<ContentType, string> = {
  'text/plain': 'txt',
  'text/markdown': 'md',
  'application/json': 'json',
};
// A refused compare-and-swap: the branch moved, was created, or another drainer holds its lock.
const CAS_REFUSED = /but expected|reference already exists|\.lock'?: File exists/;
const FIELD = '\x1f';
const RECORD = '\x1e';

interface Exec {
  stdin?: string;
  env?: Record<string, string>;
  // Exit codes that are an answer rather than a failure, such as "no such ref".
  allow?: number[];
}

interface Revision extends RevisionSummary {
  memoryId: string;
  dir: string; // <namespace>/<memoryId>, from the subject
}

// A revision read from its commit, with its record.json and, when asked for, its content file.
interface Loaded extends Revision {
  stored: Record<string, unknown>;
  content: string | null;
}

// Revisions exported as commits on one branch of a bare repository, through the installed git
// executable and plumbing commands only (10-design.md, Git provider).
export class GitHistory implements HistoryProvider {
  readonly descriptor: ProviderDescriptor = {
    id: 'history-git',
    version: '0.1.0',
    contractVersions: [1],
    capabilities: ['history.record', 'purge.history'],
    limitations: ['purge-keeps-past-revisions'],
  };

  private readonly repository: string;
  private readonly ref: string;
  private readonly gitPath: string;
  private readonly author: { name: string; email: string };
  private ready = false;
  // A scratch directory for the temporary index and blob files, and the commit whose tree that
  // index holds: one this provider moved the branch to, or null when it must be read again.
  private scratch: string | null = null;
  private indexed: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly index: RevisionIndex;

  constructor(opts: GitHistoryOptions) {
    this.repository = opts.repository;
    this.index = new RevisionIndex(join(opts.repository, 'memorykit', 'revisions'));
    this.ref = `refs/heads/${opts.branch ?? 'main'}`;
    this.gitPath = opts.gitPath ?? 'git';
    this.author = opts.author ?? { name: 'MemoryKit', email: 'memorykit@localhost' };
  }

  // Creates the repository when it is missing and refuses a newer format. When git itself is
  // unavailable the store still opens: exports stay pending until it is back.
  async open(): Promise<void> {
    try {
      await this.ensureReady();
    } catch (error) {
      if (error instanceof HistoryProviderError && error.retryable) return;
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.queue;
    if (this.scratch !== null) rmSync(this.scratch, { recursive: true, force: true });
    this.scratch = null;
    this.indexed = null;
  }

  // Exports run one at a time per provider, since they share the temporary index.
  record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    const run = this.queue.then(() => this.export(entry));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async export(entry: HistoryEntry): Promise<{ historyRef: string }> {
    await this.ensureReady();
    if (entry.payload === null && entry.operation !== 'purge') {
      throw new InternalError('A history entry has no snapshot', { seq: entry.seq });
    }
    let refused = '';
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt++) {
      // When the previous export was this provider's own commit, that commit is taken as the
      // head: nothing lies between it and `after`. If another writer has moved the branch since,
      // the compare-and-swap is refused and the next attempt reads the head and scans.
      let head: string | null;
      if (attempt === 0 && this.indexed !== null && this.indexed === entry.after) {
        head = this.indexed;
      } else {
        head = await this.head();
        const found = await this.findCommit(entry, head);
        if (found) return { historyRef: found };
      }
      let commit: string;
      try {
        commit = await this.commit(entry, entry.payload, head);
      } catch (error) {
        // On Windows two drainers writing the same loose object collide; the next attempt
        // finds the object, or the other drainer's commit.
        if (!(error instanceof HistoryProviderError) || error.details.reason !== 'git_failed') {
          throw error;
        }
        refused = error.message;
        continue;
      }
      // Compare-and-swap: another drainer that moved the branch first, or holds its lock,
      // wins, and the scan above then finds its commit. An empty old value means "absent".
      const moved = await this.git(['update-ref', this.ref, commit, head ?? ''], {
        allow: [128],
      });
      if (moved.code === 0) {
        this.indexed = commit;
        this.index.append({
          commit,
          parent: head,
          memoryId: entry.memoryId,
          revision: entry.revision,
          dir: `${entry.namespace}/${entry.memoryId}`,
        });
        return { historyRef: commit };
      }
      refused = moved.stderr.trim();
      if (!CAS_REFUSED.test(refused)) {
        throw new HistoryProviderError(`git update-ref failed: ${refused}`, true, {
          reason: 'git_failed',
        });
      }
    }
    throw new HistoryProviderError(`The history branch could not be moved: ${refused}`, true, {
      reason: 'contention',
    });
  }

  async list(memoryId: MemoryId, ns: Namespace): Promise<RevisionSummary[]> {
    const revisions = await this.revisions(memoryId, ns, null);
    return revisions.map(({ revision, operation, operationId, actor, at, historyRef }) => ({
      revision,
      operation,
      operationId,
      actor,
      at,
      historyRef,
    }));
  }

  async get(memoryId: MemoryId, ns: Namespace, revision: number): Promise<RevisionSnapshot | null> {
    const [found] = await this.revisions(memoryId, ns, revision);
    if (!found) return null;
    const { revision: n, operation, operationId, actor, at, historyRef, stored, content } = found;
    const record =
      content === null
        ? (stored as unknown as RedactedRecord)
        : ({ ...stored, content } as unknown as MemoryRecord);
    return { revision: n, operation, operationId, actor, at, historyRef, record };
  }

  // A purge commit clears the memory from the branch's tree; earlier commits, and any clone
  // or remote, still hold it.
  purgeCoverage(): Record<HistoryBoundary, BoundaryResult> {
    return {
      history_current_tree: 'removed',
      history_past_revisions: 'retained',
      history_remotes: 'not_modified',
    };
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (!existsSync(join(this.repository, 'HEAD'))) {
      mkdirSync(this.repository, { recursive: true });
      await this.git(['init', '--bare', '--quiet', this.repository], { bare: false });
      await this.git(['symbolic-ref', 'HEAD', this.ref]);
    }
    const head = await this.head();
    if (head !== null) {
      // ls-tree answers an absent path with no output, so any failure here is a real one.
      const listed = await this.git(['ls-tree', head, '--', FORMAT_PATH]);
      const format =
        listed.stdout.trim() === '' ? null : (await this.show(head, FORMAT_PATH)).trim();
      if (format !== FORMAT) {
        throw new UnsupportedContractVersionError(
          'The history repository format is not supported',
          {
            format,
            supported: [FORMAT],
          }
        );
      }
    }
    this.ready = true;
  }

  private async head(): Promise<string | null> {
    const result = await this.git(['rev-parse', '--verify', '--quiet', `${this.ref}^{commit}`], {
      allow: [1],
    });
    return result.code === 0 ? result.stdout.trim() : null;
  }

  // The commit already recorded for this entry, scanning back from the head to the previously
  // exported commit, or the whole branch when that commit is not on it. Nothing lies between
  // them when the head is that commit.
  private async findCommit(entry: HistoryEntry, head: string | null): Promise<string | null> {
    if (head === null || head === entry.after) return null;
    const range = [head];
    if (entry.after !== null && (await this.isAncestor(entry.after, head))) {
      range.push(`^${entry.after}`);
    }
    for (const commit of await this.log(range)) {
      if (
        commit.operationId === entry.operationId &&
        commit.memoryId === entry.memoryId &&
        commit.revision === entry.revision
      ) {
        return commit.historyRef;
      }
    }
    return null;
  }

  private async isAncestor(commit: string, head: string): Promise<boolean> {
    if (!/^[0-9a-f]{40,64}$/.test(commit)) return false;
    const result = await this.git(['merge-base', '--is-ancestor', commit, head], {
      allow: [1, 128],
    });
    return result.code === 0;
  }

  // A purge entry has no payload: its record.json is only a marker, and no content is kept.
  private async commit(
    entry: HistoryEntry,
    payload: MemoryRecord | RedactedRecord | null,
    head: string | null
  ): Promise<string> {
    const dir = `${entry.namespace}/${entry.memoryId}`;
    if (this.scratch === null || !existsSync(this.scratch)) {
      this.scratch = mkdtempSync(join(tmpdir(), 'memorykit-export-'));
      this.indexed = null;
    }
    const scratch = this.scratch;
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    // The index already holds the head's tree when this provider made that commit. From here it
    // matches no commit until the compare-and-swap succeeds.
    const indexed = this.indexed;
    this.indexed = null;
    if (indexed !== head || head === null) {
      if (head !== null) await this.git(['read-tree', head], { env });
      else await this.git(['read-tree', '--empty'], { env });
    }
    // An existing head's tree already has the format file, which open() checked.
    const files: [string, string][] = head === null ? [[FORMAT_PATH, `${FORMAT}\n`]] : [];
    files.push([
      `${dir}/record.json`,
      payload === null
        ? recordJson({ id: entry.memoryId, namespace: entry.namespace, purged: true, at: entry.at })
        : recordJson(payload),
    ]);
    if (payload !== null && 'content' in payload) {
      files.push([`${dir}/content.${EXTENSIONS[payload.contentType]}`, payload.content]);
    }
    const lines: string[] = [];
    // A changed content type, or a policy that stopped keeping content, leaves no stale file.
    for (const extension of Object.values(EXTENSIONS)) {
      lines.push(`0 ${'0'.repeat(40)}\t${dir}/content.${extension}`);
    }
    // One hash-object writes every blob, read from files, and prints their ids in order.
    const sources = files.map(([, text], i) => {
      const source = join(scratch, `blob-${i}`);
      writeFileSync(source, text, 'utf8');
      return source;
    });
    const blobs = await this.git(['hash-object', '-w', '--no-filters', '--stdin-paths'], {
      stdin: sources.join('\n') + '\n',
    });
    const ids = blobs.stdout.trim().split('\n');
    if (ids.length !== files.length) {
      throw new HistoryProviderError('git hash-object returned the wrong number of ids', true, {
        reason: 'git_failed',
      });
    }
    files.forEach(([path], i) => lines.push(`100644 ${ids[i]!.trim()}\t${path}`));
    await this.git(['update-index', '--index-info'], { env, stdin: lines.join('\n') + '\n' });
    const tree = (await this.git(['write-tree'], { env })).stdout.trim();
    const parents = head === null ? [] : ['-p', head];
    const message =
      `${entry.operation} ${dir} r${entry.revision}\n\n` +
      `MemoryKit-Operation: ${entry.operationId}\n` +
      `MemoryKit-Memory: ${entry.memoryId}\n` +
      `MemoryKit-Revision: ${entry.revision}\n` +
      `MemoryKit-Actor: ${encodeURIComponent(entry.actor)}\n` +
      `MemoryKit-Seq: ${entry.seq}\n`;
    const dates = { GIT_AUTHOR_DATE: entry.at, GIT_COMMITTER_DATE: entry.at };
    const created = await this.git(['commit-tree', '--no-gpg-sign', tree, ...parents], {
      stdin: message,
      env: dates,
    });
    return created.stdout.trim();
  }

  // A memory's revisions, oldest first, or only the one asked for. The revision index names the
  // commits; each is then read from Git and checked against its index entry. Listing also checks
  // every unverified branch entry before excluding commits. An index with a gap or a mismatch
  // is rebuilt and tried once more before the branch is scanned as if there were no index.
  private async revisions(
    memoryId: MemoryId,
    ns: Namespace,
    revision: number | null
  ): Promise<Loaded[]> {
    try {
      await this.ensureReady();
      const head = await this.head();
      if (head === null) return [];
      const dir = `${ns}/${memoryId}`;
      const wanted = (entries: IndexEntry[]) => {
        const own = entries.filter((entry) => entry.memoryId === memoryId);
        return revision === null
          ? own
          : own.filter((entry) => entry.revision === revision).slice(0, 1);
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        let entries = this.index.lookup(head, dir);
        if (entries === null) {
          await this.rebuildIndex(head);
          entries = this.index.lookup(head, dir);
          if (entries === null) break;
        }
        const chosen = wanted(entries.entries);
        // A revision the index does not hold is looked for on the branch itself.
        if (revision !== null && chosen.length === 0) break;
        // Before list can exclude any commit, check the whole indexed chain, including parent
        // links. Otherwise a valid-checksum wrong memory/directory can silently hide a revision.
        const unchecked = revision === null ? [...entries.unchecked] : [];
        const loaded = await this.load(chosen, dir, revision !== null, unchecked);
        if (loaded !== null) {
          this.index.confirm(unchecked);
          return loaded;
        }
        await this.rebuildIndex(head);
      }
      const scanned = (await this.log([head, '--', `${dir}/record.json`])).reverse();
      const entries = scanned.map((commit) => ({
        ...commit,
        commit: commit.historyRef,
        parent: null,
      }));
      const loaded = await this.load(wanted(entries), dir, revision !== null);
      if (loaded === null) throw new Error('A revision does not match its commit');
      return loaded;
    } catch (error) {
      if (error instanceof HistoryProviderError) throw error;
      throw new HistoryProviderError('The history repository cannot be read', true, {
        reason: 'unreadable',
      });
    }
  }

  // Every commit on the branch, from one log over it.
  private async rebuildIndex(head: string): Promise<void> {
    const trailer = (key: string) => `%(trailers:key=MemoryKit-${key},valueonly,separator=%x2c)`;
    const format = ['%H', '%P', '%s', trailer('Memory'), trailer('Revision')].join('%x1f');
    const result = await this.git(['log', '--first-parent', `--format=${format}%x1e`, head]);
    const entries: IndexEntry[] = [];
    for (const chunk of result.stdout.split(RECORD)) {
      const fields = chunk.replace(/^\n/, '').split(FIELD);
      if (fields.length < 5) continue;
      const [commit, parents, subject, memoryId, revision] = fields.map((field) =>
        field.trim()
      ) as [string, string, string, string, string];
      const number = Number(revision);
      entries.push({
        commit,
        parent: parents.split(' ')[0] || null,
        memoryId,
        revision: Number.isInteger(number) && number >= 0 ? number : 0,
        dir: subject.split(' ')[1] ?? '',
      });
    }
    this.index.rebuild(head, entries);
  }

  // Reads each entry's commit and record.json, and its content when asked, with one cat-file
  // process, together with any branch entries whose labels and parents still need verification.
  // Null when a commit is not the revision its entry names or its indexed parent is wrong.
  private async load(
    entries: IndexEntry[],
    dir: string,
    content: boolean,
    unchecked: IndexEntry[] = []
  ): Promise<Loaded[] | null> {
    if (entries.length === 0 && unchecked.length === 0) return [];
    const files = content
      ? Object.values(EXTENSIONS).map((extension) => `content.${extension}`)
      : [];
    const specs = [
      ...unchecked.map(({ commit }) => commit),
      ...entries.flatMap(({ commit }) => [
        commit,
        `${commit}:${dir}/record.json`,
        ...files.map((file) => `${commit}:${dir}/${file}`),
      ]),
    ];
    const objects = await this.batch(specs);
    for (const [i, entry] of unchecked.entries()) {
      const object = objects[i];
      const commit = object == null ? null : parseCommit(entry.commit, object);
      const headers = object?.slice(0, object.indexOf('\n\n'));
      const parent = /^parent ([0-9a-f]+)$/m.exec(headers ?? '')?.[1] ?? null;
      if (
        commit === null ||
        commit.memoryId !== entry.memoryId ||
        commit.revision !== entry.revision ||
        commit.dir !== entry.dir ||
        parent !== entry.parent
      ) {
        return null;
      }
    }
    const loaded: Loaded[] = [];
    for (const [i, entry] of entries.entries()) {
      const [object, json, ...contents] = objects.slice(
        unchecked.length + i * (2 + files.length),
        unchecked.length + (i + 1) * (2 + files.length)
      );
      const commit = object == null ? null : parseCommit(entry.commit, object);
      if (
        commit === null ||
        json == null ||
        commit.memoryId !== entry.memoryId ||
        commit.revision !== entry.revision ||
        commit.dir !== dir
      ) {
        return null;
      }
      const stored = JSON.parse(json) as Record<string, unknown>;
      const at = typeof stored.updatedAt === 'string' ? stored.updatedAt : stored.at;
      if (typeof at === 'string') commit.at = at;
      let text: string | null = null;
      const extension = EXTENSIONS[stored.contentType as ContentType] as string | undefined;
      if (content && !('contentHash' in stored) && extension !== undefined) {
        text = contents[files.indexOf(`content.${extension}`)] ?? null;
        if (text === null) return null;
      }
      loaded.push({ ...commit, stored, content: text });
    }
    return loaded;
  }

  // Commits newest first, with their trailers.
  private async log(args: string[]): Promise<Revision[]> {
    const trailer = (key: string) => `%(trailers:key=MemoryKit-${key},valueonly,separator=%x2c)`;
    const format = [
      '%H',
      '%s',
      '%aI',
      trailer('Operation'),
      trailer('Memory'),
      trailer('Revision'),
      trailer('Actor'),
    ].join('%x1f');
    const result = await this.git(['log', `--format=${format}%x1e`, ...args]);
    const commits: Revision[] = [];
    for (const chunk of result.stdout.split(RECORD)) {
      const fields = chunk.replace(/^\n/, '').split(FIELD);
      if (fields.length < 7) continue;
      const [hash, subject, date, operationId, memoryId, revision, actor] = fields.map((field) =>
        field.trim()
      ) as [string, string, string, string, string, string, string];
      const [operation, dir] = subject.split(' ');
      if (!operationId || !memoryId || !dir) continue;
      commits.push({
        historyRef: hash,
        dir,
        operation: operation as Operation,
        operationId,
        memoryId,
        revision: Number(revision),
        actor: decodeActor(actor),
        at: date,
      });
    }
    return commits;
  }

  // The objects named, in order, from one cat-file process: null for each one that is missing.
  private async batch(specs: string[]): Promise<(string | null)[]> {
    const result = await this.git(['cat-file', '--batch'], { stdin: specs.join('\n') + '\n' });
    let rest = Buffer.from(result.stdout, 'utf8');
    const objects: (string | null)[] = [];
    for (let i = 0; i < specs.length; i++) {
      const newline = rest.indexOf(0x0a);
      const header = rest.subarray(0, newline).toString('utf8');
      rest = rest.subarray(newline + 1);
      if (!/^[0-9a-f]+ [a-z]+ \d+$/.test(header)) {
        objects.push(null);
        continue;
      }
      const size = Number(header.split(' ')[2]);
      objects.push(rest.subarray(0, size).toString('utf8'));
      rest = rest.subarray(size + 1);
    }
    return objects;
  }

  private async show(commit: string, path: string): Promise<string> {
    return (await this.git(['cat-file', 'blob', `${commit}:${path}`])).stdout;
  }

  // Every command runs against the bare repository with hooks and signing turned off, so
  // nothing configured in the repository runs during an export.
  private git(
    args: string[],
    opts: Exec & { bare?: boolean } = {}
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const base = [
      '-c',
      `core.hooksPath=${join(this.repository, 'memorykit-no-hooks')}`,
      '-c',
      'commit.gpgSign=false',
    ];
    if (opts.bare !== false) base.push('--git-dir', this.repository);
    // An inherited GIT_DIR, GIT_OBJECT_DIRECTORY or similar, as under a hook, would redirect
    // the repository.
    const inherited = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_'))
    );
    const env: Record<string, string | undefined> = {
      ...inherited,
      GIT_AUTHOR_NAME: this.author.name,
      GIT_AUTHOR_EMAIL: this.author.email,
      GIT_COMMITTER_NAME: this.author.name,
      GIT_COMMITTER_EMAIL: this.author.email,
      GIT_TERMINAL_PROMPT: '0',
      ...opts.env,
    };
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.gitPath,
        [...base, ...args],
        { env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true },
        (error, stdout, stderr) => {
          if (!error) return resolve({ code: 0, stdout, stderr });
          const code = typeof error.code === 'number' ? error.code : null;
          if (code !== null && opts.allow?.includes(code)) {
            return resolve({ code, stdout, stderr });
          }
          if (code === null) {
            return reject(
              new HistoryProviderError('The git executable cannot be run', true, {
                reason: 'git_unavailable',
                outage: true,
              })
            );
          }
          reject(
            new HistoryProviderError(`git ${args[0]} failed: ${stderr.trim()}`, true, {
              reason: 'git_failed',
            })
          );
        }
      );
      // git may exit before reading its input; the exit code then reports the failure.
      child.stdin?.on('error', () => undefined);
      if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);
      else child.stdin?.end();
    });
  }
}

// Actors are encoded in their trailer, so a line break or comma cannot forge another trailer.
function decodeActor(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

// The record without its content: sorted keys, two-space indent and a trailing newline.
function recordJson(payload: MemoryRecord | RedactedRecord | Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...payload };
  delete rest.content;
  return JSON.stringify(sortKeys(rest), null, 2) + '\n';
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

// A commit object as the revision it exports, or null when it does not name one.
function parseCommit(hash: string, text: string): Revision | null {
  const split = text.indexOf('\n\n');
  if (split < 0) return null;
  const author = /^author .* (\d+) ([+-]\d{4})$/m.exec(text.slice(0, split));
  const [subject = '', ...body] = text.slice(split + 2).split('\n');
  const trailers = new Map<string, string>();
  for (const line of body) {
    const match = /^MemoryKit-(\w+): (.*)$/.exec(line);
    if (match && !trailers.has(match[1]!)) trailers.set(match[1]!, match[2]!.trim());
  }
  const [operation, dir] = subject.split(' ');
  const operationId = trailers.get('Operation');
  const memoryId = trailers.get('Memory');
  if (!operationId || !memoryId || !dir || !author) return null;
  return {
    historyRef: hash,
    dir,
    operation: operation as Operation,
    operationId,
    memoryId,
    revision: Number(trailers.get('Revision')),
    actor: decodeActor(trailers.get('Actor') ?? ''),
    at: isoDate(Number(author[1]), author[2]!),
  };
}

// A Git timestamp as git log's %aI prints it.
function isoDate(seconds: number, zone: string): string {
  const offset =
    (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3)));
  const local = new Date((seconds + offset * 60) * 1000).toISOString().slice(0, 19);
  return `${local}${zone.slice(0, 3)}:${zone.slice(3)}`;
}
