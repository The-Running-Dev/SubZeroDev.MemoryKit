// Direct composition through the installed public entries, including an interrupted
// supersede export and recovery with a fresh Git provider.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EMBEDDED_PRINCIPAL,
  MemoryHistory,
  MemoryService,
  SqliteStorage,
  type HistoryEntry,
  type HistoryProvider,
} from 'subzerodev-memorykit';
import { GitHistory, type GitHistoryOptions } from 'subzerodev-memorykit/history-git';

class UnmarkedOnce extends SqliteStorage {
  failNext = false;

  override async markExported(seq: number, ref: string, token: number): Promise<boolean> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('interrupted after export before mark');
    }
    return super.markExported(seq, ref, token);
  }
}

const entries: HistoryEntry[] = [];
class RecordingGit extends GitHistory {
  override async record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    entries.push(structuredClone(entry));
    return super.record(entry);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'memorykit-git-consumer-'));
const repository = join(dir, 'custom.git');
const options: GitHistoryOptions = {
  repository,
  branch: 'revisions',
  author: { name: 'Consumer', email: 'consumer@example.test' },
};
function git(...args: string[]): string {
  const result = spawnSync('git', ['--git-dir', repository, ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

try {
  const storage = new UnmarkedOnce({ path: join(dir, 'memory.db') });
  let service = new MemoryService(storage, new RecordingGit(options));
  await service.open();
  try {
    const client = service.as(EMBEDDED_PRINCIPAL);
    const original = (await client.create({ namespace: 'app', kind: 'note', content: 'old' }))
      .memory;
    const input = {
      id: original.id,
      expectedRevision: 1,
      replacement: { kind: 'note', content: 'new' },
    };
    const write = { operationId: 'consumer-supersede' };
    storage.failNext = true;
    const interrupted = await client.supersede(input, write);
    assert.equal(interrupted.history, 'pending');
    await service.close();
    assert.equal(git('rev-list', '--count', 'revisions'), '2');

    service = new MemoryService(
      new SqliteStorage({ path: join(dir, 'memory.db') }),
      new RecordingGit(options)
    );
    await service.open();
    const recovered = service.as(EMBEDDED_PRINCIPAL);
    await recovered.syncHistory();
    const replay = await recovered.supersede(input, write);
    assert.equal(replay.history, 'persisted');
    assert.deepEqual(replay.memory, interrupted.memory);
    assert.deepEqual(replay.related, interrupted.related);
    assert.equal(git('rev-list', '--count', 'revisions'), '3');
    assert.equal(
      git('log', '-1', '--format=%an <%ae>', 'revisions'),
      'Consumer <consumer@example.test>'
    );
    const target = await recovered.revision(original.id, 2);
    const replacement = await recovered.revision(replay.memory.id, 1);
    assert.equal(target.operationId, write.operationId);
    assert.equal(replacement.operationId, write.operationId);
    assert.notEqual(target.historyRef, replacement.historyRef);
    assert.ok('content' in target.record);
    assert.ok('content' in replacement.record);
    assert.equal(target.record.content, 'old');
    assert.equal(replacement.record.content, 'new');

    const supersedeEntries = [
      ...new Map(
        entries
          .filter((entry) => entry.operationId === write.operationId)
          .map((entry) => [entry.memoryId, entry])
      ).values(),
    ];
    assert.equal(supersedeEntries.length, 2);
    // Retry both entries with the original 'after', as after a lost acknowledgement.
    // Both providers must distinguish the two records sharing one operation id.
    for (const history of [
      new GitHistory(options),
      new MemoryHistory(),
    ] satisfies HistoryProvider[]) {
      await history.open();
      try {
        const refs: string[] = [];
        for (const entry of supersedeEntries) {
          const first = await history.record(entry);
          assert.deepEqual(await history.record(entry), first);
          refs.push(first.historyRef);
          const revisions = await history.list(entry.memoryId, entry.namespace);
          assert.equal(revisions.filter((r) => r.operationId === write.operationId).length, 1);
        }
        assert.notEqual(refs[0], refs[1]);
      } finally {
        await history.close();
      }
    }
    assert.equal(git('rev-list', '--count', 'revisions'), '3');
    console.log('installed GitHistory composition and supersede retry ok');
  } finally {
    await service.close();
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
