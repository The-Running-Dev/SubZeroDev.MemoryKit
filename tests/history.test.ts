import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import {
  HistoryProviderError,
  type HistoryEntry,
  type HistoryProvider,
} from '../src/contracts/index.ts';
import { MemoryHistory } from '../src/history-memory/index.ts';
import { sha256Hex, type MemoryKitError } from '../src/model/index.ts';
import { MemoryService, type ServiceConfig } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { REPO_ROOT, runNode, runNodeAsync, tempDir } from './helpers.ts';

const FIXTURES = join(REPO_ROOT, 'tests', 'fixtures');

// Memory history that fails while `failure` is set and keeps every entry it was handed.
class ControlledHistory extends MemoryHistory {
  failure: MemoryKitError | null = null;
  readonly calls: HistoryEntry[] = [];
  readonly refs: string[] = [];

  override async record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    this.calls.push(structuredClone(entry));
    if (this.failure) throw this.failure;
    const result = await super.record(entry);
    this.refs.push(result.historyRef);
    return result;
  }
}

function databaseOf(dir: string): string {
  return join(dir, 'memory.db');
}

async function openService(
  dir: string,
  history: HistoryProvider | null,
  config: ServiceConfig = {},
  storage = new SqliteStorage({ path: databaseOf(dir) })
): Promise<MemoryService> {
  const service = new MemoryService(storage, history, config);
  await service.open();
  return service;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<MemoryKitError> {
  try {
    await promise;
  } catch (error) {
    assert.equal((error as MemoryKitError).code, code);
    return error as MemoryKitError;
  }
  assert.fail(`expected ${code}`);
}

const unreachable = () =>
  new HistoryProviderError('History is unreachable', true, { reason: 'unreachable' });

describe('history outbox', () => {
  it('S3.1 memory history returns every revision without loading Git', () => {
    const result = runNode(join(FIXTURES, 'history-modules.ts'), [tempDir()]);
    assert.equal(result.status, 0, result.stderr);
    const { created, revisions, original, urls } = JSON.parse(result.stdout);
    assert.equal(created.history, 'persisted');
    assert.equal(created.historyRef, 'mem:1');
    assert.deepEqual(
      revisions.map((item: { revision: number; operation: string }) => [
        item.revision,
        item.operation,
      ]),
      [
        [1, 'create'],
        [2, 'update'],
      ]
    );
    assert.equal(original.record.content, 'first');
    assert.ok(urls.some((url: string) => url.includes('history-memory')));
    assert.deepEqual(
      urls.filter((url: string) => /history-git|child_process/.test(url)),
      []
    );
  });

  it('S3.2 a write while history fails is pending, and a reopen after a kill exports it', async () => {
    const dir = tempDir();
    const child = spawn(process.execPath, [
      '--no-warnings',
      join(FIXTURES, 'failing-history.ts'),
      dir,
    ]);
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const line = await new Promise<string>((resolve, reject) => {
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        stdout += chunk;
        const end = stdout.indexOf('\n');
        if (end >= 0) resolve(stdout.slice(0, end));
      });
      child.on('exit', (code) => reject(new Error(`fixture exited ${code}: ${stderr}`)));
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    const outcome = JSON.parse(line);
    assert.equal(outcome.storage, 'persisted');
    assert.equal(outcome.history, 'pending');
    assert.equal(outcome.historyRef, null);

    const history = new MemoryHistory();
    const service = await openService(dir, history);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const status = await client.operation(outcome.operationId);
      assert.equal(status.history, 'persisted');
      assert.match(status.historyRef ?? '', /^mem:/);
      const revisions = await client.history(outcome.memory.id);
      assert.deepEqual(
        revisions.map((item) => item.revision),
        [1, 2]
      );
      assert.deepEqual((await client.status()).historyQueue, {
        pending: 0,
        blocked: null,
        lastError: null,
      });
    } finally {
      await service.close();
    }
  });

  it('S3.3 updates while history fails are all exported after recovery', async () => {
    const history = new ControlledHistory();
    const service = await openService(tempDir(), history);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'v1' });
      assert.equal(created.history, 'persisted');
      const id = created.memory.id;
      history.failure = unreachable();
      for (const revision of [1, 2, 3]) {
        const outcome = await client.update({
          id,
          expectedRevision: revision,
          content: `v${revision + 1}`,
        });
        assert.equal(outcome.history, 'pending');
      }
      assert.deepEqual((await client.status()).historyQueue, {
        pending: 3,
        blocked: null,
        lastError: 'unreachable',
      });

      history.failure = null;
      assert.deepEqual(await client.syncHistory(), { pending: 0, blocked: null, lastError: null });
      for (const revision of [2, 3, 4]) {
        const snapshot = await client.revision(id, revision);
        assert.equal((snapshot.record as { content: string }).content, `v${revision}`);
      }
      assert.equal((await client.history(id)).length, 4);
    } finally {
      await service.close();
    }
  });

  it('S3.4 an entry recorded but not marked is recorded again with the same ref', async () => {
    class UnmarkedOnce extends SqliteStorage {
      failed = false;
      override async markExported(seq: number, ref: string, token: number): Promise<boolean> {
        if (!this.failed) {
          this.failed = true;
          throw new Error('process died before the mark');
        }
        return super.markExported(seq, ref, token);
      }
    }
    const dir = tempDir();
    const history = new ControlledHistory();
    const service = await openService(
      dir,
      history,
      {},
      new UnmarkedOnce({ path: databaseOf(dir) })
    );
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'once' });
      assert.equal(created.history, 'pending');
      assert.deepEqual(await client.syncHistory(), { pending: 0, blocked: null, lastError: null });
      assert.equal(history.calls.length, 2);
      assert.deepEqual(history.calls[0], history.calls[1]);
      assert.deepEqual(history.refs, ['mem:1', 'mem:1']);
      assert.equal((await client.history(created.memory.id)).length, 1);
      assert.equal((await client.operation(created.operationId)).historyRef, 'mem:1');
    } finally {
      await service.close();
    }
  });

  it('an operation with several entries reports the worst of their statuses', async () => {
    const history = new ControlledHistory();
    const service = await openService(tempDir(), history);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'v1' });
      history.failure = new HistoryProviderError('The provider refused the entry', false, {
        reason: 'refused',
      });
      const superseded = await client.supersede({
        id: created.memory.id,
        expectedRevision: 1,
        replacement: { kind: 'note', content: 'v2' },
      });
      assert.equal(superseded.history, 'blocked');
      assert.equal((await client.operation(superseded.operationId)).history, 'blocked');
    } finally {
      await service.close();
    }
  });

  it('S3.5 a non-retryable failure blocks the queue until it is retried', async () => {
    const history = new ControlledHistory();
    const service = await openService(tempDir(), history);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'v1' });
      const id = created.memory.id;
      history.failure = new HistoryProviderError('The provider refused the entry', false, {
        reason: 'refused',
      });
      const blocked = await client.update({ id, expectedRevision: 1, content: 'v2' });
      assert.equal(blocked.history, 'blocked');
      const calls = history.calls.length;
      const later = await client.update({ id, expectedRevision: 2, content: 'v3' });
      assert.equal(later.history, 'pending');
      assert.equal(history.calls.length, calls, 'nothing after a blocked entry is exported');

      const { historyQueue } = await client.status();
      assert.equal(historyQueue.pending, 1);
      assert.equal(historyQueue.blocked?.operationId, blocked.operationId);
      assert.equal(historyQueue.blocked?.error, 'refused');
      const blockedSeq = historyQueue.blocked?.seq ?? 0;

      history.failure = null;
      assert.deepEqual(await client.syncHistory(), historyQueue, 'blocked stays without retry');
      assert.deepEqual(await client.syncHistory({ retryBlocked: true }), {
        pending: 0,
        blocked: null,
        lastError: null,
      });
      const exported = history.calls.slice(calls);
      assert.deepEqual(
        exported.map((entry) => entry.seq),
        [blockedSeq, blockedSeq + 1]
      );
      assert.deepEqual(
        (await client.history(id)).map((item) => item.revision),
        [1, 2, 3]
      );
      assert.equal((await client.operation(blocked.operationId)).history, 'persisted');
    } finally {
      await service.close();
    }
  });

  it('writes during a retry backoff leave the entry to the timer', async () => {
    const history = new ControlledHistory();
    const service = await openService(tempDir(), history, { maxExportAttempts: 3 });
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      history.failure = new HistoryProviderError('History is unreachable', true);
      for (let i = 0; i < 6; i++) {
        const outcome = await client.create({ namespace: 'demo', kind: 'note', content: `${i}` });
        assert.equal(outcome.history, 'pending');
      }
      assert.equal(history.calls.length, 1, 'one attempt, then backoff');
      assert.deepEqual(await client.syncHistory({ budgetMs: 1000 }), {
        pending: 6,
        blocked: null,
        lastError: 'HistoryUnavailable',
      });
      history.failure = null;
      assert.deepEqual(await client.syncHistory(), { pending: 0, blocked: null, lastError: null });
    } finally {
      await service.close();
    }
  });

  it('S3.6 policy metadata keeps a hash instead of content; policy none keeps nothing', async () => {
    const history = new ControlledHistory();
    const service = await openService(tempDir(), history);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      assert.deepEqual(await client.getNamespace('secret'), {
        name: 'secret',
        historyPolicy: 'full',
      });
      await client.setNamespacePolicy('secret', 'metadata');
      assert.equal((await client.getNamespace('secret')).historyPolicy, 'metadata');
      const created = await client.create({
        namespace: 'secret',
        kind: 'note',
        content: 'classified',
        metadata: { zeta: 1, alpha: 'x' },
      });
      assert.equal(created.history, 'persisted');
      const payload = history.calls[0]?.payload as Record<string, unknown>;
      assert.equal(history.calls[0]?.policy, 'metadata');
      assert.equal('content' in payload, false);
      assert.equal('metadata' in payload, false);
      assert.equal(payload.contentHash, sha256Hex('classified'));
      assert.deepEqual(payload.metadataKeys, ['alpha', 'zeta']);
      const snapshot = await client.revision(created.memory.id, 1);
      assert.equal('content' in snapshot.record, false);

      await client.setNamespacePolicy('off', 'none');
      const off = await client.create({ namespace: 'off', kind: 'note', content: 'gone' });
      assert.equal(off.history, 'not_required');
      assert.equal(off.historyRef, null);
      assert.equal(history.calls.length, 1);
      await rejectsWith(client.history(off.memory.id), 'HistoryNotRetained');
      await rejectsWith(client.revision(off.memory.id, 1), 'HistoryNotRetained');

      const invalid = await rejectsWith(
        client.setNamespacePolicy('off', 'partial' as 'full'),
        'ValidationFailed'
      );
      assert.deepEqual(invalid.details, { field: 'historyPolicy', reason: 'unsupported' });
    } finally {
      await service.close();
    }
  });

  it('S3.7 two processes race for the lease and a stale token cannot mark', async () => {
    const dir = tempDir();
    const database = databaseOf(dir);
    const setup = new SqliteStorage({ path: database });
    await setup.open();
    await setup.close();
    const results = await Promise.all(
      ['a', 'b'].map((holder) => runNodeAsync(join(FIXTURES, 'lease.ts'), [database, holder]))
    );
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    const leases = results.map((result) => JSON.parse(result.stdout) as { token: number } | null);
    const held = leases.filter((lease) => lease !== null);
    assert.equal(held.length, 1, JSON.stringify(leases));
    const token = held[0]!.token;

    // With the lease held elsewhere, this service queues but cannot export.
    const service = await openService(dir, new MemoryHistory(), { historyWaitMs: 0 });
    const created = await service
      .as(EMBEDDED_PRINCIPAL)
      .create({ namespace: 'demo', kind: 'note', content: 'x' });
    assert.equal(created.history, 'pending');
    await service.close();

    const storage = new SqliteStorage({ path: database });
    await storage.open();
    try {
      assert.equal(await storage.acquireDrainLease('c', 30_000), null);
      const next = await storage.nextOutbox();
      assert.ok(next !== null && !('blocked' in next));
      assert.equal(await storage.markExported(next.seq, 'mem:1', token - 1), false);
      assert.equal(
        await storage.markFailed(next.seq, { code: 'x', message: 'x' }, true, token + 1),
        false
      );
      assert.equal(await storage.markExported(next.seq, 'mem:1', token), true);
      assert.deepEqual(await storage.queue(), { pending: 0, blocked: null, lastError: null });
    } finally {
      await storage.close();
    }
  });

  it('operations older than the retention are pruned on open', async () => {
    const dir = tempDir();
    let service = await openService(dir, null);
    const client = service.as(EMBEDDED_PRINCIPAL);
    const created = await client.create(
      { namespace: 'demo', kind: 'note', content: 'x' },
      { operationId: 'op-old' }
    );
    await client.create(
      { namespace: 'demo', kind: 'note', content: 'y' },
      { operationId: 'op-new' }
    );
    const status = await client.operation('op-old');
    assert.deepEqual(status, {
      operationId: 'op-old',
      memoryId: created.memory.id,
      revision: 1,
      storage: 'persisted',
      history: 'not_required',
      historyRef: null,
    });
    await service.close();

    const db = new DatabaseSync(databaseOf(dir));
    db.prepare('UPDATE operations SET created_at = ? WHERE operation_id = ?').run(
      new Date(Date.now() - 8 * 86_400_000).toISOString(),
      'op-old'
    );
    db.close();

    service = await openService(dir, null);
    try {
      const reopened = service.as(EMBEDDED_PRINCIPAL);
      const missing = await rejectsWith(reopened.operation('op-old'), 'NotFound');
      assert.deepEqual(missing.details, { operationId: 'op-old' });
      assert.equal((await reopened.operation('op-new')).history, 'not_required');
      await rejectsWith(reopened.operation(undefined as unknown as string), 'ValidationFailed');
    } finally {
      await service.close();
    }
  });

  it('history reads are scoped, wrapped and validated', async () => {
    class BrokenReads extends MemoryHistory {
      override async list(): Promise<never> {
        throw new Error('disk gone');
      }
    }
    const service = await openService(tempDir(), new BrokenReads());
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'x' });
      const id = created.memory.id;
      const unavailable = await rejectsWith(client.history(id), 'HistoryUnavailable');
      assert.deepEqual(unavailable.details, { provider: 'history-memory' });
      await rejectsWith(client.revision(id, 0), 'ValidationFailed');
      const missing = await rejectsWith(client.revision(id, 9), 'NotFound');
      assert.deepEqual(missing.details, { id, revision: 9 });
      await rejectsWith(
        client.update({ id, expectedRevision: 1, content: 'y' }, { waitForHistoryMs: -1 }),
        'ValidationFailed'
      );

      const reader = service.as({
        id: 'reader',
        profile: 'embedded',
        grants: [{ pattern: 'demo', permissions: ['read'] }],
      });
      await rejectsWith(reader.history(id), 'NotFound');
      await rejectsWith(reader.syncHistory(), 'Forbidden');
      await rejectsWith(reader.setNamespacePolicy('demo', 'none'), 'Forbidden');
      await rejectsWith(reader.getNamespace('other'), 'Forbidden');
      assert.equal((await reader.status()).history?.id, 'history-memory');
      await rejectsWith(reader.operation(created.operationId), 'NotFound');
      const nobody = service.as({ id: 'nobody', profile: 'embedded', grants: [] });
      await rejectsWith(nobody.status(), 'Forbidden');
    } finally {
      await service.close();
    }
  });
});
