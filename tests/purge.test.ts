import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL, type Principal } from '../src/access/index.ts';
import {
  HistoryProviderError,
  type HistoryEntry,
  type HistoryProvider,
  type PurgeReport,
} from '../src/contracts/index.ts';
import { GitHistory } from '../src/history-git/index.ts';
import { MemoryHistory } from '../src/history-memory/index.ts';
import type { MemoryKitError } from '../src/model/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { tempDir } from './helpers.ts';

function git(repository: string, args: string[]): string {
  const result = spawnSync('git', ['--git-dir', repository, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// Git history that refuses every entry while `failing` is set.
class FailingGit extends GitHistory {
  failing = false;

  override async record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    if (this.failing) {
      throw new HistoryProviderError('History is unreachable', true, { reason: 'unreachable' });
    }
    return super.record(entry);
  }
}

async function openService(dir: string, history: HistoryProvider | null): Promise<MemoryService> {
  const storage = new SqliteStorage({ path: join(dir, 'memory.db') });
  const service = new MemoryService(storage, history, { historyWaitMs: 2_000 });
  await service.open();
  return service;
}

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error) => {
    assert.equal((error as MemoryKitError).code, code);
    return true;
  });
}

const results = (report: PurgeReport) =>
  Object.fromEntries(Object.entries(report.boundaries).map(([name, item]) => [name, item.result]));

describe('S11 purge', () => {
  it('S11.1 a purge with Git history reports each boundary and leaves a purged record', async () => {
    const dir = tempDir();
    const repository = join(dir, 'history.git');
    const service = await openService(dir, new GitHistory({ repository }));
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'secret' });
      const { id } = created.memory;
      const report = await client.purge({ id, expectedRevision: 1 });
      assert.deepEqual(results(report), {
        current_storage: 'removed',
        pending_history: 'removed',
        history_current_tree: 'removed',
        history_past_revisions: 'retained',
        history_remotes: 'not_modified',
        external_copies: 'outside_control',
      });
      await rejectsWith(client.get(id), 'NotFound');
      const record = JSON.parse(git(repository, ['show', `main:demo/${id}/record.json`]));
      assert.equal(record.purged, true);
      const tree = git(repository, ['ls-tree', '--name-only', `main:demo/${id}`]);
      assert.deepEqual(tree.trim().split('\n'), ['record.json']);
      assert.match(git(repository, ['log', '-1', '--format=%s', 'main']), /^purge /);
    } finally {
      await service.close();
    }
  });

  it('S11.2 a purge while history fails discards pending entries before they reach Git', async () => {
    const dir = tempDir();
    const repository = join(dir, 'history.git');
    const history = new FailingGit({ repository });
    const service = await openService(dir, history);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      history.failing = true;
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'secret' });
      const { id } = created.memory;
      await client.update({ id, expectedRevision: 1, content: 'more secret' });
      const report = await client.purge({ id, expectedRevision: 2 }, { operationId: 'purge-2' });
      assert.deepEqual(report.boundaries.pending_history, {
        result: 'removed',
        detail: '2 pending entries discarded',
      });
      assert.equal(report.boundaries.history_current_tree.result, 'failed');

      history.failing = false;
      assert.deepEqual(await client.syncHistory(), { pending: 0, blocked: null, lastError: null });
      const again = await client.purge({ id, expectedRevision: 2 }, { operationId: 'purge-2' });
      assert.equal(again.boundaries.history_current_tree.result, 'removed');
      assert.equal(again.boundaries.pending_history.result, 'removed');
      const everything = git(repository, ['log', '--all', '-p', '--format=%B']);
      assert.doesNotMatch(everything, /secret/);
      const record = JSON.parse(git(repository, ['show', `main:demo/${id}/record.json`]));
      assert.equal(record.purged, true);
    } finally {
      await service.close();
    }
  });

  it('S11.3 write and tombstone without purge is Forbidden', async () => {
    const service = await openService(tempDir(), new MemoryHistory());
    try {
      const created = await service
        .as(EMBEDDED_PRINCIPAL)
        .create({ namespace: 'demo', kind: 'note', content: 'kept' });
      const editor: Principal = {
        id: 'editor',
        profile: 'local',
        grants: [{ pattern: 'demo', permissions: ['read', 'write', 'tombstone'] }],
      };
      const { id } = created.memory;
      await rejectsWith(service.as(editor).purge({ id, expectedRevision: 1 }), 'Forbidden');
      assert.equal((await service.as(editor).get(id)).content, 'kept');
    } finally {
      await service.close();
    }
  });

  it('S11.4 the same operation id returns the same report; a stale revision conflicts', async () => {
    const service = await openService(tempDir(), new MemoryHistory());
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const a = await client.create({ namespace: 'demo', kind: 'note', content: 'a' });
      const b = await client.create({ namespace: 'demo', kind: 'note', content: 'b' });
      const id = a.memory.id;
      await client.update({ id, expectedRevision: 1, content: 'a2' });
      await rejectsWith(client.purge({ id, expectedRevision: 1 }), 'RevisionConflict');
      const first = await client.purge({ id, expectedRevision: 2 }, { operationId: 'p' });
      const second = await client.purge({ id, expectedRevision: 2 }, { operationId: 'p' });
      assert.deepEqual(second, first);
      await rejectsWith(
        client.purge({ id: b.memory.id, expectedRevision: 1 }, { operationId: 'p' }),
        'IdempotencyMismatch'
      );
      assert.equal((await client.operation('p')).memoryId, id);
    } finally {
      await service.close();
    }
  });

  it('S11.5 the report follows the provider: MemoryHistory removes past revisions', async () => {
    const service = await openService(tempDir(), new MemoryHistory());
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'x' });
      const report = await client.purge({ id: created.memory.id, expectedRevision: 1 });
      assert.deepEqual(results(report), {
        current_storage: 'removed',
        pending_history: 'removed',
        history_current_tree: 'removed',
        history_past_revisions: 'removed',
        history_remotes: 'not_modified',
        external_copies: 'outside_control',
      });
    } finally {
      await service.close();
    }
  });

  it('S11.5 without a history provider, history boundaries are not modified', async () => {
    const service = await openService(tempDir(), null);
    try {
      const client = service.as(EMBEDDED_PRINCIPAL);
      const created = await client.create({ namespace: 'demo', kind: 'note', content: 'x' });
      const report = await client.purge({ id: created.memory.id, expectedRevision: 1 });
      assert.deepEqual(results(report), {
        current_storage: 'removed',
        pending_history: 'not_modified',
        history_current_tree: 'not_modified',
        history_past_revisions: 'not_modified',
        history_remotes: 'not_modified',
        external_copies: 'outside_control',
      });
    } finally {
      await service.close();
    }
  });
});
