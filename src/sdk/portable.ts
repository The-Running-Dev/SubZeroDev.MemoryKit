// Local administrator API: an offline, integrity-checked current store + retained Git history.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { StorageSnapshot } from '../contracts/index.ts';
import { HISTORY_POLICIES } from '../contracts/index.ts';
import {
  canonicalJson,
  sha256Hex,
  ValidationFailedError,
  StoreBusyError,
  UnsupportedError,
  MEMORY_STATES,
  DEFAULT_LIMITS,
  validateCreate,
  validateMemoryId,
  validateRevision,
  parseNamespace,
  isPlainObject,
} from '../model/index.ts';
import type { StoreConfig } from './index.ts';
import { createStorage, STORE_MARKER } from './storage.ts';

export interface PortableArchive {
  format: 'memorykit-portable';
  version: 1;
  snapshot: StorageSnapshot;
  git: { head: string; bundle: string } | null;
  // Secrets/grants and process operation IDs must be reissued at the destination.
  exclusions: ['tokens', 'operation-replay'];
  checksum: string;
}
const checksum = (a: Omit<PortableArchive, 'checksum'>) => sha256Hex(canonicalJson(a));
async function git(repository: string, args: string[]): Promise<string> {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync('git', ['--no-optional-locks', '--git-dir', repository, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  });
  if (r.status !== 0) throw new ValidationFailedError('Portable Git history verification failed');
  return r.stdout.trim();
}
function historyRepository(config: StoreConfig): string {
  if (config.history?.provider === 'memory')
    throw new UnsupportedError('In-memory history cannot be migrated');
  return config.history?.provider === 'git' && config.history.repository
    ? resolve(config.history.repository)
    : join(resolve(config.path), 'history.git');
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function validateArchive(value: unknown): asserts value is PortableArchive {
  if (!isPlainObject(value)) throw new ValidationFailedError('Invalid portable archive');
  const { checksum: hash, ...body } = value;
  if (
    !exact(value, ['format', 'version', 'snapshot', 'git', 'exclusions', 'checksum']) ||
    value.format !== 'memorykit-portable' ||
    value.version !== 1 ||
    hash !== sha256Hex(canonicalJson(body)) ||
    canonicalJson(value.exclusions) !== canonicalJson(['tokens', 'operation-replay']) ||
    !isPlainObject(value.snapshot) ||
    !Array.isArray(value.snapshot.records) ||
    !Array.isArray(value.snapshot.namespaces) ||
    !exact(value.snapshot, ['records', 'namespaces', 'anchor'])
  )
    throw new ValidationFailedError('Invalid portable archive or checksum');
  const ids = new Set<string>(),
    keys = new Set<string>(),
    names = new Set<string>();
  for (const r of value.snapshot.records) {
    if (
      !isPlainObject(r) ||
      !exact(r, [
        'id',
        'namespace',
        'key',
        'kind',
        'content',
        'contentType',
        'metadata',
        'links',
        'state',
        'priorState',
        'revision',
        'provenance',
        'actor',
        'createdAt',
        'updatedAt',
      ])
    )
      throw new ValidationFailedError('Invalid portable record');
    const { id, revision, state, priorState, actor, createdAt, updatedAt, ...input } = r;
    validateMemoryId(id);
    validateRevision(revision);
    const { key, ...rest } = input;
    validateCreate({ ...rest, ...(key === null ? {} : { key }) }, DEFAULT_LIMITS);
    if (
      typeof id !== 'string' ||
      ids.has(id) ||
      !MEMORY_STATES.includes(state as never) ||
      (state === 'tombstoned'
        ? !['active', 'superseded', 'archived'].includes(String(priorState))
        : priorState !== null) ||
      typeof actor !== 'string' ||
      !actor ||
      typeof createdAt !== 'string' ||
      typeof updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(createdAt)) ||
      !Number.isFinite(Date.parse(updatedAt)) ||
      Date.parse(updatedAt) < Date.parse(createdAt)
    )
      throw new ValidationFailedError('Invalid portable lifecycle');
    ids.add(id);
    if (key !== null) {
      const k = canonicalJson([input.namespace, key]);
      if (keys.has(k)) throw new ValidationFailedError('Duplicate portable key');
      keys.add(k);
    }
  }
  for (const n of value.snapshot.namespaces) {
    if (
      !isPlainObject(n) ||
      !exact(n, ['name', 'historyPolicy']) ||
      typeof n.name !== 'string' ||
      names.has(n.name) ||
      !HISTORY_POLICIES.includes(n.historyPolicy as never)
    )
      throw new ValidationFailedError('Invalid portable namespace');
    parseNamespace(n.name);
    names.add(n.name);
  }
  if (value.snapshot.records.some((r) => !names.has(r.namespace)))
    throw new ValidationFailedError('Portable record has no namespace policy');
  const anchor = value.snapshot.anchor;
  if (
    anchor !== null &&
    (!isPlainObject(anchor) ||
      !exact(anchor, ['entry', 'ref']) ||
      !isPlainObject(anchor.entry) ||
      !exact(anchor.entry, [
        'seq',
        'operationId',
        'memoryId',
        'revision',
        'operation',
        'actor',
        'at',
        'namespace',
        'policy',
        'payload',
      ]) ||
      typeof anchor.ref !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(anchor.ref) ||
      !Number.isSafeInteger(anchor.entry.seq) ||
      Number(anchor.entry.seq) < 1)
  )
    throw new ValidationFailedError('Invalid portable history anchor');
  if (anchor) {
    const e = anchor.entry as Record<string, unknown>;
    validateMemoryId(e.memoryId);
    validateRevision(e.revision);
    if (typeof e.namespace !== 'string')
      throw new ValidationFailedError('Invalid portable history namespace');
    parseNamespace(e.namespace);
    if (
      typeof e.operationId !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(e.operationId) ||
      !['create', 'update', 'archive', 'supersede', 'tombstone', 'restore', 'purge'].includes(
        String(e.operation)
      ) ||
      typeof e.actor !== 'string' ||
      !e.actor ||
      typeof e.at !== 'string' ||
      !Number.isFinite(Date.parse(e.at)) ||
      !['full', 'metadata'].includes(String(e.policy)) ||
      e.payload !== null
    )
      throw new ValidationFailedError('Invalid portable history entry');
  }
  if (
    value.git !== null &&
    (!isPlainObject(value.git) ||
      !exact(value.git, ['head', 'bundle']) ||
      typeof value.git.head !== 'string' ||
      !/^[a-f0-9]{40,64}$/.test(value.git.head) ||
      typeof value.git.bundle !== 'string' ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.git.bundle))
  )
    throw new ValidationFailedError('Invalid portable Git bundle');
  if (anchor && (!value.git || value.git.head !== anchor.ref))
    throw new ValidationFailedError('Portable history does not match the current store');
}

/** Stop writers and drain history first. Fails if state changes during the export. */
export async function exportStore(config: StoreConfig): Promise<PortableArchive> {
  const repository = historyRepository(config);
  const { storage } = await createStorage(config.path, config.storage, false);
  await storage.open();
  const scratch = mkdtempSync(join(tmpdir(), 'memorykit-export-'));
  try {
    if (!storage.snapshot)
      throw new UnsupportedError('Storage plugin does not support portable snapshots');
    const snapshot = await storage.snapshot();
    let history: PortableArchive['git'] = null;
    if (config.history?.provider !== 'none' && existsSync(join(repository, 'HEAD'))) {
      const head = await git(repository, [
        'for-each-ref',
        '--format=%(objectname)',
        'refs/heads/main',
      ]);
      if (head) {
        const bundle = join(scratch, 'history.bundle');
        await git(repository, ['bundle', 'create', bundle, 'refs/heads/main']);
        history = { head, bundle: readFileSync(bundle).toString('base64') };
      }
    }
    if (canonicalJson(snapshot) !== canonicalJson(await storage.snapshot()))
      throw new StoreBusyError('Store changed during export; stop writers and retry');
    const body: Omit<PortableArchive, 'checksum'> = {
      format: 'memorykit-portable',
      version: 1,
      snapshot,
      git: history,
      exclusions: ['tokens', 'operation-replay'],
    };
    const archive = { ...body, checksum: checksum(body) };
    validateArchive(archive);
    return archive;
  } finally {
    await storage.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** Creates a new destination, verifies the restored snapshot, then exposes its directory. */
export async function importStore(
  config: StoreConfig,
  value: unknown
): Promise<{ records: number; checksum: string }> {
  validateArchive(value);
  historyRepository(config);
  const target = resolve(config.path);
  if (existsSync(target) || (config.history?.provider === 'git' && config.history.repository))
    throw new ValidationFailedError(
      'Migration requires a new destination directory and local history'
    );
  if (value.git && config.history?.provider === 'none')
    throw new ValidationFailedError('Archive includes Git history; choose Git at the destination');
  mkdirSync(dirname(target), { recursive: true });
  const stage = mkdtempSync(join(dirname(target), '.memorykit-import-'));
  let complete = false;
  try {
    if (value.git) {
      const bundle = join(stage, 'history.bundle');
      writeFileSync(bundle, Buffer.from(value.git.bundle, 'base64'), { flag: 'wx', mode: 0o600 });
      const repository = join(stage, 'history.git');
      await git(repository, ['init', '--bare', repository]);
      await git(repository, ['bundle', 'verify', bundle]);
      await git(repository, ['fetch', bundle, 'refs/heads/main:refs/heads/main']);
      if ((await git(repository, ['rev-parse', 'refs/heads/main'])) !== value.git.head)
        throw new ValidationFailedError('Restored Git head differs');
      rmSync(bundle);
    }
    const { storage } = await createStorage(stage, config.storage, true);
    await storage.open();
    try {
      if (!storage.restoreSnapshot || !storage.snapshot)
        throw new UnsupportedError('Storage plugin does not support portable snapshots');
      await storage.restoreSnapshot(value.snapshot);
      if (canonicalJson(await storage.snapshot()) !== canonicalJson(value.snapshot))
        throw new ValidationFailedError('Restored snapshot differs');
    } finally {
      await storage.close();
    }
    // Never replace an existing destination, including one created during preparation.
    if (existsSync(target)) throw new ValidationFailedError('Destination appeared during import');
    if (config.storage?.provider && config.storage.provider !== 'sqlite')
      writeFileSync(
        join(stage, STORE_MARKER),
        JSON.stringify({ version: 1, provider: config.storage.provider }),
        { flag: 'wx' }
      );
    renameSync(stage, target);
    complete = true;
    return { records: value.snapshot.records.length, checksum: value.checksum };
  } finally {
    if (!complete) rmSync(stage, { recursive: true, force: true });
  }
}
