import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { NotFoundError, StoreBusyError, toProblem, ValidationFailedError } from '../model/index.ts';
import type { MemoryClient } from '../service/index.ts';
import {
  fetchGitSource,
  gitSourceStatus,
  inspectGitSource,
  syncGitSource,
  type GitSourceConfig,
  type GitSourceStatus,
  type GitSourceSyncResult,
  type GitSourceSyncState,
} from './git-source.ts';

// Keeping configured Git sources current: the per-source state file, a lease so one sync runs
// per store, the cheap due check a host hook can afford, and the diagnostics `doctor` reports.
// Everything here names sources by configured id; no request can supply a path, ref or URL.

export const SOURCE_LEASE_MS = 5 * 60_000;
export const SOURCE_SYNC_DEADLINE_MS = 120_000;

// What a serving unit knows about its configured sources.
export interface SourceRuntime {
  sources: GitSourceConfig[];
  // The state file (`<profile>.sources.json`). Without one, no cursor or lease is kept.
  stateFile?: string;
}

const SHA = /^[0-9a-f]{40,64}$/;
const count = (n: unknown): number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 ? n : 0;

// The cursor is only an optimization, so a missing or malformed file means a full reconcile,
// never an error.
export function readSourceStates(file: string | undefined): Record<string, GitSourceSyncState> {
  const states: Record<string, GitSourceSyncState> = {};
  if (!file || !existsSync(file)) return states;
  let raw: unknown;
  try {
    if (statSync(file).size > 1024 * 1024) return states;
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return states;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return states;
  for (const [id, value] of Object.entries(raw)) {
    if (typeof value !== 'object' || value === null) continue;
    const s = value as Record<string, unknown>;
    states[id] = {
      cursor: typeof s.cursor === 'string' && SHA.test(s.cursor) ? s.cursor : null,
      skipped: count(s.skipped),
      conflicts: count(s.conflicts),
      archived: count(s.archived),
      ...(typeof s.lastRunAt === 'string' && s.lastRunAt.length <= 40
        ? { lastRunAt: s.lastRunAt }
        : {}),
      ...(s.fetch === 'ok' || s.fetch === 'failed' ? { fetch: s.fetch } : {}),
      ...(typeof s.failure === 'string' && /^[A-Za-z]{1,40}$/.test(s.failure)
        ? { failure: s.failure }
        : {}),
    };
  }
  return states;
}

export function writeSourceStates(file: string, states: Record<string, GitSourceSyncState>): void {
  const temp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(states, null, 2));
  renameSync(temp, file);
}

export function findSource(runtime: SourceRuntime | undefined, id: unknown): GitSourceConfig {
  const source =
    typeof id === 'string' ? runtime?.sources.find((candidate) => candidate.id === id) : undefined;
  if (!source) throw new NotFoundError('No such configured source');
  return source;
}

// --- Lease ---------------------------------------------------------------------------------

interface LeaseBody {
  token: string;
  pid: number;
  expiresAt: number;
}

export interface Lease {
  release(): void;
}

const leaseFile = (stateFile: string): string => `${stateFile}.lock`;

function readLease(file: string): LeaseBody | null {
  try {
    const body = JSON.parse(readFileSync(file, 'utf8')) as Partial<LeaseBody>;
    if (typeof body.token === 'string' && typeof body.expiresAt === 'number')
      return body as LeaseBody;
  } catch {
    /* Unreadable: judged by age below. */
  }
  return null;
}

function expired(file: string, ttlMs: number, now: number): boolean {
  const body = readLease(file);
  if (body) return body.expiresAt <= now;
  try {
    return statSync(file).mtimeMs + ttlMs <= now;
  } catch {
    return true;
  }
}

export function leaseHeld(stateFile: string, ttlMs = SOURCE_LEASE_MS, now = Date.now()): boolean {
  const file = leaseFile(stateFile);
  return existsSync(file) && !expired(file, ttlMs, now);
}

// One holder per state file. A holder that crashed leaves its lease behind, and the first
// caller after it expires takes it over: the stale file is renamed away (only one renamer
// succeeds), then the lease is created exclusively.
export function acquireLease(
  stateFile: string,
  ttlMs = SOURCE_LEASE_MS,
  now = Date.now()
): Lease | null {
  const file = leaseFile(stateFile);
  const token = randomUUID();
  const create = (): boolean => {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ token, pid: process.pid, expiresAt: now + ttlMs } satisfies LeaseBody)
        );
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };
  if (!create()) {
    if (!expired(file, ttlMs, now)) return null;
    try {
      renameSync(file, `${file}.${token}.stale`);
      unlinkSync(`${file}.${token}.stale`);
    } catch {
      return null;
    }
    if (!create()) return null;
  }
  return {
    release() {
      if (readLease(file)?.token !== token) return;
      try {
        unlinkSync(file);
      } catch {
        /* Already gone. */
      }
    },
  };
}

// --- Due check -----------------------------------------------------------------------------

export interface DueSource {
  id: string;
  commit: string;
}

// One `rev-parse` per auto source, no document content, nothing written. A source whose
// repository or ref is unusable is not due: the sync would fail, and `doctor` reports it.
export function dueSources(
  sources: readonly GitSourceConfig[],
  states: Record<string, GitSourceSyncState>
): DueSource[] {
  const due: DueSource[] = [];
  for (const source of sources) {
    if (source.auto !== true) continue;
    const { commit } = inspectGitSource(source);
    if (commit !== null && states[source.id]?.cursor !== commit)
      due.push({ id: source.id, commit });
  }
  return due;
}

// --- Sync ----------------------------------------------------------------------------------

export interface SourceSyncOptions {
  deadlineMs?: number;
  maxChanges?: number;
}

async function syncOne(
  client: MemoryClient,
  runtime: SourceRuntime,
  source: GitSourceConfig,
  options: SourceSyncOptions
): Promise<GitSourceSyncResult> {
  const fetched = source.fetch === undefined ? undefined : fetchGitSource(source);
  const states = readSourceStates(runtime.stateFile);
  let result: GitSourceSyncResult | undefined;
  let failure: string | undefined;
  try {
    result = await syncGitSource(client, source, {
      cursor: states[source.id]?.cursor ?? null,
      deadlineMs: options.deadlineMs ?? SOURCE_SYNC_DEADLINE_MS,
      ...(options.maxChanges === undefined ? {} : { maxChanges: options.maxChanges }),
    });
  } catch (error) {
    failure = toProblem(error).code;
    throw error;
  } finally {
    if (runtime.stateFile) {
      const latest = readSourceStates(runtime.stateFile);
      const base = result?.state ?? latest[source.id] ?? states[source.id];
      latest[source.id] = {
        cursor: base?.cursor ?? null,
        skipped: base?.skipped ?? 0,
        conflicts: base?.conflicts ?? 0,
        archived: base?.archived ?? 0,
        lastRunAt: new Date().toISOString(),
        ...(fetched === undefined
          ? {}
          : { fetch: fetched ? ('ok' as const) : ('failed' as const) }),
        ...(failure === undefined && result?.failures[0] === undefined
          ? {}
          : { failure: failure ?? result!.failures[0]!.code }),
      };
      writeSourceStates(runtime.stateFile, latest);
    }
  }
  return result!;
}

// Syncs one configured source under the store's lease. A sync already running is a retryable
// `StoreBusy`, not a second sync.
export async function syncConfiguredSource(
  client: MemoryClient,
  runtime: SourceRuntime,
  id: unknown,
  options: SourceSyncOptions = {}
): Promise<GitSourceSyncResult> {
  const source = findSource(runtime, id);
  const lease = runtime.stateFile ? acquireLease(runtime.stateFile) : undefined;
  if (runtime.stateFile && !lease)
    throw new StoreBusyError('A source sync is already running', { reason: 'source_sync_running' });
  try {
    return await syncOne(client, runtime, source, options);
  } finally {
    lease?.release();
  }
}

export interface DueRun {
  ran: boolean;
  reason?: 'leased' | 'nothing_due';
  results: GitSourceSyncResult[];
  failures: { source: string; code: string }[];
}

// `source sync --due`: every auto source whose tip moved, one at a time, under one lease.
// A failing source does not stop the others.
export async function syncDueSources(
  client: MemoryClient,
  runtime: SourceRuntime,
  options: SourceSyncOptions = {}
): Promise<DueRun> {
  if (!runtime.stateFile)
    throw new ValidationFailedError('Syncing due sources needs a profile (--profile)');
  const lease = acquireLease(runtime.stateFile);
  if (!lease) return { ran: false, reason: 'leased', results: [], failures: [] };
  const run: DueRun = { ran: true, results: [], failures: [] };
  try {
    const due = dueSources(runtime.sources, readSourceStates(runtime.stateFile));
    if (due.length === 0) return { ...run, ran: false, reason: 'nothing_due' };
    for (const { id } of due) {
      try {
        run.results.push(await syncOne(client, runtime, findSource(runtime, id), options));
      } catch (error) {
        run.failures.push({ source: id, code: toProblem(error).code });
      }
    }
    return run;
  } finally {
    lease.release();
  }
}

// --- Status and diagnostics ----------------------------------------------------------------

export function sourceStatusOf(
  runtime: SourceRuntime | undefined,
  id: unknown
): GitSourceStatus & { fetch: string | null; lastRunAt: string | null; failure: string | null } {
  const source = findSource(runtime, id);
  const state = readSourceStates(runtime?.stateFile)[source.id];
  return {
    ...gitSourceStatus(source, state),
    fetch: state?.fetch ?? null,
    lastRunAt: state?.lastRunAt ?? null,
    failure: state?.failure ?? null,
  };
}

export interface SourceHealth {
  source: string;
  auto: boolean;
  repository: 'ok' | 'unreachable';
  ref: 'ok' | 'unresolved' | null;
  fetch: 'off' | 'ok' | 'failed';
  lag: number | null;
  conflicts: number | null;
  due: boolean;
  lastRunAt: string | null;
  failure: string | null;
  // Unreachable repositories, refs that do not resolve and failed fetches fail `doctor`;
  // conflicts and lag are reported.
  problems: string[];
  ok: boolean;
}

// Per source: is the repository there, does the ref resolve, did the last fetch work, how far
// behind is it, and how many conflicts wait. No paths, keys or document content.
export function inspectSources(runtime: SourceRuntime): SourceHealth[] {
  const states = readSourceStates(runtime.stateFile);
  return runtime.sources.map((source) => {
    const state = states[source.id];
    const inspected = inspectGitSource(source);
    let lag: number | null = null;
    if (inspected.commit !== null) {
      try {
        lag = gitSourceStatus(source, state).lag;
      } catch {
        lag = null;
      }
    }
    const fetch = source.fetch === undefined ? 'off' : (state?.fetch ?? 'ok');
    const hard: string[] = [];
    if (!inspected.repository) hard.push('repository_unreachable');
    else if (inspected.commit === null) hard.push('ref_unresolved');
    if (fetch === 'failed') hard.push('fetch_failed');
    const soft: string[] = [];
    if ((state?.conflicts ?? 0) > 0) soft.push('conflicts');
    if (lag !== null && lag > 0) soft.push('lag');
    if (inspected.commit !== null && state === undefined) soft.push('never_synced');
    return {
      source: source.id,
      auto: source.auto === true,
      repository: inspected.repository ? 'ok' : 'unreachable',
      ref: !inspected.repository ? null : inspected.commit === null ? 'unresolved' : 'ok',
      fetch,
      lag,
      conflicts: state?.conflicts ?? null,
      due: source.auto === true && inspected.commit !== null && state?.cursor !== inspected.commit,
      lastRunAt: state?.lastRunAt ?? null,
      failure: state?.failure ?? null,
      problems: [...hard, ...soft],
      ok: hard.length === 0,
    };
  });
}
