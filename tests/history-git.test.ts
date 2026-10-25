import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import type { HistoryEntry, HistoryProvider } from '../src/contracts/index.ts';
import { GitHistory } from '../src/history-git/index.ts';
import { MemoryHistory } from '../src/history-memory/index.ts';
import type { MemoryId, MemoryKitError } from '../src/model/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { runCli, tempDir } from './helpers.ts';

const IDENTITY = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
};

// Plain git against a repository, as an operator would run it.
function git(repository: string, args: string[], input?: string): string {
  const result = spawnSync('git', ['--git-dir', repository, ...args], {
    encoding: 'utf8',
    input,
    env: { ...process.env, ...IDENTITY },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function commitCount(repository: string): number {
  return Number(git(repository, ['rev-list', '--count', 'main']).trim());
}

// Storage whose next markExported fails as a crash between update-ref and the mark would.
class UnmarkedOnce extends SqliteStorage {
  failNext = false;

  override async markExported(seq: number, historyRef: string, token: number): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('crashed before the mark');
    }
    return super.markExported(seq, historyRef, token);
  }
}

// Memory history that keeps the entries it was handed.
class RecordingHistory extends MemoryHistory {
  readonly handed: HistoryEntry[] = [];

  override async record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    this.handed.push(structuredClone(entry));
    return super.record(entry);
  }
}

// Two memories, in namespaces demo and other, each with revisions r1 to r3 whose content is
// their name, as the entries a drain hands the provider.
async function recorded(): Promise<{ handed: HistoryEntry[]; ids: MemoryId[] }> {
  const recording = new RecordingHistory();
  const service = await openService(tempDir(), recording);
  const ids: MemoryId[] = [];
  try {
    const client = service.as(EMBEDDED_PRINCIPAL);
    for (const ns of ['demo', 'other']) {
      const created = await client.create({ namespace: ns, kind: 'note', content: 'r1' });
      ids.push(created.memory.id);
      for (const revision of [1, 2]) {
        await client.update({
          id: created.memory.id,
          expectedRevision: revision,
          content: `r${revision + 1}`,
        });
      }
    }
  } finally {
    await service.close();
  }
  return { handed: recording.handed, ids };
}

// The same, exported to a new repository.
async function exported(): Promise<{ repository: string; ids: MemoryId[] }> {
  const { handed, ids } = await recorded();
  const repository = join(tempDir(), 'history.git');
  const history = new GitHistory({ repository });
  let after: string | null = null;
  for (const entry of handed) after = (await history.record({ ...entry, after })).historyRef;
  await history.close();
  return { repository, ids };
}

const NAMESPACES = ['demo', 'other'];

interface Read {
  revision: number;
  historyRef: string;
  content: string | null;
}

// Every revision of the memories from recorded(), through list and get.
async function readAll(history: GitHistory, ids: MemoryId[]): Promise<Read[][]> {
  const all: Read[][] = [];
  for (const [i, id] of ids.entries()) {
    const reads: Read[] = [];
    for (const item of await history.list(id, NAMESPACES[i]!)) {
      const snapshot = await history.get(id, NAMESPACES[i]!, item.revision);
      assert.equal(snapshot?.at, item.at);
      assert.equal(snapshot?.historyRef, item.historyRef);
      const content =
        snapshot !== null && 'content' in snapshot.record ? snapshot.record.content : null;
      reads.push({ revision: item.revision, historyRef: item.historyRef, content });
    }
    all.push(reads);
  }
  return all;
}

// The same, read with plain git.
function scanned(repository: string, ids: MemoryId[]): Read[][] {
  const commits = git(repository, [
    'log',
    '--format=%H %(trailers:key=MemoryKit-Memory,key=MemoryKit-Revision,valueonly,separator=%x20)',
    'main',
  ])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim().split(' ') as [string, string, string])
    .reverse();
  return ids.map((id, i) =>
    commits
      .filter(([, memory]) => memory === id)
      .map(([hash, , revision]) => ({
        revision: Number(revision),
        historyRef: hash,
        content: git(repository, ['show', `${hash}:${NAMESPACES[i]}/${id}/content.txt`]),
      }))
  );
}

// A provider whose git subcommands are recorded.
function counted(history: GitHistory): { history: GitHistory; calls: string[] } {
  const calls: string[] = [];
  const target = history as unknown as {
    git: (args: string[], exec?: object) => Promise<unknown>;
  };
  const git = target.git;
  target.git = function (this: unknown, args, exec) {
    calls.push(args[0]!);
    return git.call(this, args, exec);
  };
  return { history, calls };
}

async function openService(
  dir: string,
  history: HistoryProvider,
  storage = new SqliteStorage({ path: join(dir, 'memory.db') })
): Promise<MemoryService> {
  const service = new MemoryService(storage, history);
  await service.open();
  return service;
}

// The same revisions through any provider: full and metadata-only namespaces, read back
// through history and revision. Ids, timestamps and refs differ between runs and are replaced
// once each revision's timestamp is checked against its record.
async function revisionScenario(history: HistoryProvider): Promise<unknown> {
  const service = await openService(tempDir(), history);
  try {
    const client = service.as(EMBEDDED_PRINCIPAL);
    const created = await client.create({
      namespace: 'demo',
      kind: 'note',
      content: 'first',
      metadata: { priority: 'high' },
    });
    const id = created.memory.id;
    await client.update({
      id,
      expectedRevision: 1,
      content: '# second',
      contentType: 'text/markdown',
    });
    await client.setNamespacePolicy('quiet', 'metadata');
    const quiet = await client.create({
      namespace: 'quiet',
      kind: 'note',
      content: 'secret',
      metadata: { k: 'v' },
    });
    const result = {
      history: await client.history(id),
      first: await client.revision(id, 1),
      second: await client.revision(id, 2),
      quietHistory: await client.history(quiet.memory.id),
      quiet: await client.revision(quiet.memory.id, 1),
    };
    for (const [list, snapshots] of [
      [result.history, [result.first, result.second]],
      [result.quietHistory, [result.quiet]],
    ] as const) {
      assert.deepEqual(
        list.map((item) => item.at),
        snapshots.map((snapshot) => snapshot.record.updatedAt)
      );
    }
    const ids = new Map([
      [id, '<demo>'],
      [quiet.memory.id, '<quiet>'],
    ]);
    return JSON.parse(
      JSON.stringify(result, (key, value: unknown) => {
        if (['historyRef', 'operationId', 'at', 'createdAt', 'updatedAt'].includes(key))
          return '<varies>';
        if (typeof value === 'string' && ids.has(value)) return ids.get(value);
        return value;
      })
    );
  } finally {
    await service.close();
  }
}

describe('git history', () => {
  it('S4.1 create and update become commits with trailers and the current content', () => {
    const store = join(tempDir(), 'store');
    assert.equal(runCli(['init', store]).status, 0);
    const created = runCli([
      'create',
      '--store',
      store,
      '--namespace',
      'demo',
      '--kind',
      'note',
      '--content',
      'first',
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const first = JSON.parse(created.stdout);
    const id = first.memory.id as string;
    const updated = runCli([
      'update',
      id,
      '--store',
      store,
      '--expected-revision',
      '1',
      '--content',
      'second',
      '--json',
    ]);
    assert.equal(updated.status, 0, updated.stderr);
    const second = JSON.parse(updated.stdout);
    assert.equal(second.history, 'persisted');

    const repository = join(store, 'history.git');
    const log = git(repository, [
      'log',
      'main',
      '--format=%s%x1f%(trailers:key=MemoryKit-Operation,valueonly)%x1e',
    ])
      .split('\x1e')
      .map((chunk) => chunk.trim())
      .filter(Boolean)
      .map((chunk) => chunk.split('\x1f').map((field) => field.trim()));
    assert.deepEqual(log, [
      [`update demo/${id} r2`, second.operationId],
      [`create demo/${id} r1`, first.operationId],
    ]);
    assert.equal(git(repository, ['show', `main:demo/${id}/content.txt`]), 'second');
    assert.equal(git(repository, ['show', 'main:.memorykit/format']), '1\n');
  });

  it('S4.2 Git history returns what memory history returns, from one scenario', async () => {
    const fromMemory = await revisionScenario(new MemoryHistory());
    const fromGit = await revisionScenario(
      new GitHistory({ repository: join(tempDir(), 'history.git') })
    );
    assert.deepEqual(fromGit, fromMemory);
  });

  it('S4.3 a crash after update-ref and before the mark is marked on restart without a new commit', async () => {
    const dir = tempDir();
    const repository = join(dir, 'history.git');
    const storage = new UnmarkedOnce({ path: join(dir, 'memory.db') });
    let service = await openService(dir, new GitHistory({ repository }), storage);
    const client = service.as(EMBEDDED_PRINCIPAL);
    const created = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
    storage.failNext = true;
    const updated = await client.update({
      id: created.memory.id,
      expectedRevision: 1,
      content: 'b',
    });
    assert.equal(updated.history, 'pending');
    await service.close();
    assert.equal(commitCount(repository), 2, 'the commit landed before the crash');
    const head = git(repository, ['rev-parse', 'main']).trim();

    service = await openService(dir, new GitHistory({ repository }));
    try {
      const status = await service.as(EMBEDDED_PRINCIPAL).operation(updated.operationId);
      assert.equal(status.history, 'persisted');
      assert.equal(status.historyRef, head);
      assert.equal(commitCount(repository), 2);
    } finally {
      await service.close();
    }
  });

  it('S4.4 drainers racing on the same entry, one with an expired lease, make one commit', async () => {
    const recording = new RecordingHistory();
    const service = await openService(tempDir(), recording);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
      await client.update({ id: created.memory.id, expectedRevision: 1, content: 'b' });
    } finally {
      await service.close();
    }
    const repository = join(tempDir(), 'history.git');
    const drainers = [new GitHistory({ repository }), new GitHistory({ repository })];
    for (const drainer of drainers) await drainer.open();

    let after: string | null = null;
    for (const entry of recording.handed) {
      const refs = await Promise.all(
        [...drainers, ...drainers].map((drainer) => drainer.record({ ...entry, after }))
      );
      assert.equal(new Set(refs.map((ref) => ref.historyRef)).size, 1);
      after = refs[0]!.historyRef;
    }
    assert.equal(commitCount(repository), 2);
    const parents = git(repository, ['rev-list', '--parents', 'main'])
      .trim()
      .split('\n')
      .map((line) => line.split(' ').length - 1);
    assert.deepEqual(parents, [1, 0], 'linear history');
  });

  it('S4.5 without git on PATH writes stay pending and status names the error', async () => {
    const path = join(tempDir(), 'store');
    await initStore({ path });
    const saved = process.env.PATH;
    let client: Awaited<ReturnType<typeof openStore>> | null = null;
    try {
      process.env.PATH = '';
      client = await openStore({ path });
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
      assert.equal(created.history, 'pending');
      const updated = await client.update({
        id: created.memory.id,
        expectedRevision: 1,
        content: 'b',
      });
      assert.equal(updated.history, 'pending');
      const status = await client.status();
      assert.equal(status.history?.id, 'history-git');
      assert.equal(status.historyQueue.pending, 2);
      assert.equal(status.historyQueue.lastError, 'git_unavailable');

      process.env.PATH = saved;
      assert.deepEqual(await client.syncHistory(), { pending: 0, blocked: null, lastError: null });
      const revisions = await client.history(created.memory.id);
      assert.deepEqual(
        revisions.map((item) => item.revision),
        [1, 2]
      );
    } finally {
      process.env.PATH = saved;
      await client?.close();
    }
    assert.equal(commitCount(join(path, 'history.git')), 2);
  });

  it('S4.6 a repository of format 2 fails to open', async () => {
    const path = join(tempDir(), 'store');
    await initStore({ path });
    const repository = join(path, 'history.git');
    const blob = git(repository, ['hash-object', '-w', '--stdin'], '2\n').trim();
    const inner = git(repository, ['mktree'], `100644 blob ${blob}\tformat\n`).trim();
    const root = git(repository, ['mktree'], `040000 tree ${inner}\t.memorykit\n`).trim();
    const commit = git(repository, ['commit-tree', root], 'format 2\n').trim();
    git(repository, ['update-ref', 'refs/heads/main', commit]);
    await assert.rejects(openStore({ path }), (error: MemoryKitError) => {
      assert.equal(error.code, 'UnsupportedContractVersion');
      return true;
    });
  });

  it('S4.7 repository hooks do not run during an export', async () => {
    const path = join(tempDir(), 'store');
    await initStore({ path });
    const repository = join(path, 'history.git');
    const marker = join(tempDir(), 'hook-ran').replaceAll('\\', '/');
    const hooks = join(repository, 'hooks');
    mkdirSync(hooks, { recursive: true });
    for (const name of ['reference-transaction', 'post-commit']) {
      const hook = join(hooks, name);
      writeFileSync(hook, `#!/bin/sh\necho ${name} >> "${marker}"\n`);
      chmodSync(hook, 0o755);
    }
    const client = await openStore({ path });
    try {
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
      assert.equal(created.history, 'persisted');
      assert.equal(existsSync(marker), false, 'the first export ran no hook');

      // Plain git does run the hooks, so their absence above is the provider's doing.
      git(repository, ['update-ref', 'refs/heads/probe', 'main']);
      assert.equal(existsSync(marker), true, 'the probe ran the hook');
      git(repository, ['update-ref', '-d', 'refs/heads/probe']);
      rmSync(marker);

      const updated = await client.update({
        id: created.memory.id,
        expectedRevision: 1,
        content: 'b',
      });
      assert.equal(updated.history, 'persisted');
      assert.equal(existsSync(marker), false);
    } finally {
      await client.close();
    }
  });

  it('an actor cannot forge a trailer, and an inherited GIT_ environment is ignored', async () => {
    const actor = 'bob\nMemoryKit-Operation: forged, x';
    const recording = new RecordingHistory();
    const service = await openService(tempDir(), recording);
    try {
      await service
        .as({ ...EMBEDDED_PRINCIPAL, id: actor })
        .create({ namespace: 'demo', kind: 'note', content: 'a' });
    } finally {
      await service.close();
    }
    const entry = recording.handed[0]!;
    const repository = join(tempDir(), 'history.git');
    const foreign = join(tempDir(), 'objects');
    const saved = process.env.GIT_OBJECT_DIRECTORY;
    process.env.GIT_OBJECT_DIRECTORY = foreign;
    try {
      const history = new GitHistory({ repository });
      await history.open();
      const first = await history.record({ ...entry, after: null });
      const again = await history.record({ ...entry, after: null });
      assert.equal(again.historyRef, first.historyRef);
      const [summary] = await history.list(entry.memoryId, entry.namespace);
      assert.equal(summary?.actor, actor);
      assert.equal(summary?.operationId, entry.operationId);
    } finally {
      if (saved === undefined) delete process.env.GIT_OBJECT_DIRECTORY;
      else process.env.GIT_OBJECT_DIRECTORY = saved;
    }
    assert.equal(commitCount(repository), 1);
    assert.equal(existsSync(foreign), false);
  });

  it('two drainers taking turns rescan when the other moved the branch, and keep every revision', async () => {
    const recording = new RecordingHistory();
    const service = await openService(tempDir(), recording);
    const ids: string[] = [];
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      for (const ns of ['demo', 'other']) {
        const created = await client.create({ namespace: ns, kind: 'note', content: 'r1' });
        ids.push(created.memory.id);
        for (let revision = 1; revision < 4; revision++) {
          await client.update({
            id: created.memory.id,
            expectedRevision: revision,
            content: `r${revision + 1}`,
          });
        }
      }
    } finally {
      await service.close();
    }
    const entries = recording.handed;
    assert.equal(entries.length, 8);
    const repository = join(tempDir(), 'history.git');
    const a = new GitHistory({ repository });
    const b = new GitHistory({ repository });
    await a.open();
    await b.open();

    // A, A, B, A, ... with `after` the last marked ref. Entry 5 was committed by B, which
    // crashed before the mark: A, whose own commit is still `after`, takes that commit as the
    // head, is refused by the compare-and-swap, and then finds B's commit.
    const moves: string[] = [];
    const git = (a as unknown as { git: (args: string[], exec?: object) => Promise<unknown> }).git;
    (a as unknown as { git: typeof git }).git = function (this: unknown, args, exec) {
      if (args[0] === 'update-ref') moves.push(args[2]!);
      return git.call(this, args, exec);
    };
    const drainer = [a, a, b, a, a, b, a, a];
    let after: string | null = null;
    for (const [i, entry] of entries.entries()) {
      if (i === 5) {
        const crashed = await b.record({ ...entry, after });
        moves.length = 0;
        const found = await a.record({ ...entry, after });
        assert.equal(found.historyRef, crashed.historyRef);
        assert.equal(moves.length, 1, 'one refused compare-and-swap');
        after = found.historyRef;
        continue;
      }
      after = (await drainer[i]!.record({ ...entry, after })).historyRef;
    }
    // A replay of every entry against its own `after` makes no commit.
    let previous: string | null = null;
    for (const entry of entries) {
      previous = (await b.record({ ...entry, after: previous })).historyRef;
    }
    assert.equal(previous, after);
    assert.equal(commitCount(repository), 8);
    for (const [i, id] of ids.entries()) {
      const ns = i === 0 ? 'demo' : 'other';
      const listed = await a.list(id, ns);
      assert.deepEqual(
        listed.map((item) => item.revision),
        [1, 2, 3, 4]
      );
      for (const revision of [1, 2, 3, 4]) {
        const snapshot = await b.get(id, ns, revision);
        assert.equal(
          snapshot !== null && 'content' in snapshot.record ? snapshot.record.content : null,
          `r${revision}`
        );
      }
    }
    await a.close();
    await b.close();
  });

  it('an export survives its scratch directory being removed, and close removes it', async () => {
    const recording = new RecordingHistory();
    const service = await openService(tempDir(), recording);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
      await client.update({ id: created.memory.id, expectedRevision: 1, content: 'b' });
      await client.update({ id: created.memory.id, expectedRevision: 2, content: 'c' });
    } finally {
      await service.close();
    }
    const repository = join(tempDir(), 'history.git');
    const history = new GitHistory({ repository });
    await history.open();
    const scratch = () => (history as unknown as { scratch: string | null }).scratch;
    let after: string | null = null;
    for (const [i, entry] of recording.handed.entries()) {
      if (i === 1) rmSync(scratch()!, { recursive: true, force: true });
      after = (await history.record({ ...entry, after })).historyRef;
    }
    assert.equal(commitCount(repository), 3);
    const last = scratch();
    assert.ok(last !== null && existsSync(last));
    await history.close();
    assert.equal(existsSync(last), false);
  });

  it('revisions are read through the index with two git processes, and a missing index is rebuilt', async () => {
    const { repository, ids } = await exported();
    const index = join(repository, 'memorykit', 'revisions');
    assert.ok(existsSync(index), 'the exporter writes the index');
    const expected = scanned(repository, ids);

    const reader = counted(new GitHistory({ repository }));
    await reader.history.open();
    reader.calls.length = 0;
    assert.deepEqual(await readAll(reader.history, ids), expected);
    assert.equal(reader.calls.includes('log'), false, 'no history scan');
    reader.calls.length = 0;
    await reader.history.get(ids[0]!, 'demo', 2);
    assert.deepEqual(reader.calls, ['rev-parse', 'cat-file']);

    rmSync(index);
    const rebuilt = counted(new GitHistory({ repository }));
    await rebuilt.history.open();
    rebuilt.calls.length = 0;
    assert.deepEqual(await readAll(rebuilt.history, ids), expected);
    assert.equal(rebuilt.calls.filter((call) => call === 'log').length, 1, 'one rebuild');
    assert.ok(existsSync(index), 'the rebuild writes the index');
    await reader.history.close();
    await rebuilt.history.close();
  });

  it('a stale, damaged or wrong index is ignored or rebuilt, and Git decides every answer', async () => {
    const { repository, ids } = await exported();
    const index = join(repository, 'memorykit', 'revisions');
    const expected = scanned(repository, ids);
    const lines = readFileSync(index, 'utf8').split('\n');

    // Stale: the index of another repository, whose commits are not on this branch.
    const other = await exported();
    writeFileSync(index, readFileSync(join(other.repository, 'memorykit', 'revisions')));
    assert.deepEqual(await readAll(new GitHistory({ repository }), ids), expected);

    // Damaged: a torn last line and a changed character fail their checksums.
    const damaged = [...lines];
    damaged[2] = damaged[2]!.replace(/ (\d) /, (_, digit: string) => ` ${Number(digit) + 1} `);
    writeFileSync(index, damaged.join('\n').slice(0, -10));
    assert.deepEqual(await readAll(new GitHistory({ repository }), ids), expected);

    // Wrong but well formed: two revisions of the first memory swapped, with valid checksums.
    const swapped = lines.map((text) => {
      const fields = text.split(' ');
      if (fields.length !== 6 || fields[2] !== ids[0]) return text;
      const revision = { '2': '3', '3': '2' }[fields[3]!] ?? fields[3]!;
      const body = [...fields.slice(0, 3), revision, fields[4]].join(' ');
      return `${body} ${createHash('sha256').update(body).digest('hex').slice(0, 16)}`;
    });
    writeFileSync(index, swapped.join('\n'));
    const history = new GitHistory({ repository });
    const snapshot = await history.get(ids[0]!, 'demo', 2);
    assert.equal(
      snapshot !== null && 'content' in snapshot.record && snapshot.record.content,
      'r2'
    );
    assert.deepEqual(await readAll(history, ids), expected);
    assert.equal(await history.get(ids[0]!, 'demo', 9), null);

    // Not an index at all.
    writeFileSync(index, 'garbage\n');
    assert.deepEqual(await readAll(new GitHistory({ repository }), ids), expected);
  });

  it('a reader picks up commits another process appends to the index', async () => {
    const { handed } = await recorded();
    const repository = join(tempDir(), 'history.git');
    const writer = new GitHistory({ repository });
    const reader = counted(new GitHistory({ repository }));
    let after: string | null = null;
    for (const entry of handed) {
      after = (await writer.record({ ...entry, after })).historyRef;
      const id = entry.memoryId as MemoryId;
      const ns = entry.namespace;
      reader.calls.length = 0;
      const listed = await reader.history.list(id, ns);
      assert.equal(listed.at(-1)?.revision, entry.revision);
      assert.equal(reader.calls.includes('log'), false, 'no rebuild');
    }
    await writer.close();
    await reader.history.close();
  });

  it('a missing git executable never blocks the queue', async () => {
    const dir = tempDir();
    const service = new MemoryService(
      new SqliteStorage({ path: join(dir, 'memory.db') }),
      new GitHistory({ repository: join(dir, 'history.git'), gitPath: join(dir, 'no-git') }),
      { maxExportAttempts: 1, historyWaitMs: 0 }
    );
    await service.open();
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
      assert.equal(created.history, 'pending');
      const queue = await client.syncHistory({ budgetMs: 200 });
      assert.equal(queue.pending, 1);
      assert.equal(queue.blocked, null);
      assert.equal(queue.lastError, 'git_unavailable');
    } finally {
      await service.close();
    }
  });
});
