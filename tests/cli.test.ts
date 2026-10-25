import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import { run, type CliDeps } from '../src/cli/run.ts';
import { HistoryProviderError, type HistoryEntry } from '../src/contracts/index.ts';
import { MemoryHistory } from '../src/history-memory/index.ts';
import { newMemoryId } from '../src/model/index.ts';
import { DATABASE_FILE } from '../src/sdk/index.ts';
import { MemoryService } from '../src/service/index.ts';
import { SqliteStorage } from '../src/storage-sqlite/index.ts';
import { SCHEMA_VERSION } from '../src/storage-sqlite/schema.ts';
import { runCli, tempDir } from './helpers.ts';

class FailingHistory extends MemoryHistory {
  failing = true;
  retryable = true;

  override async record(entry: HistoryEntry): Promise<{ historyRef: string }> {
    if (this.failing) throw new HistoryProviderError('History is unreachable', this.retryable);
    return super.record(entry);
  }
}

describe('cli', () => {
  it('S1.3 init, create and get in separate processes', () => {
    const store = join(tempDir(), 'store');
    const init = runCli(['init', store]);
    assert.equal(init.status, 0, init.stderr);
    assert.equal(init.stderr, '');

    const create = runCli([
      'create',
      '--store',
      store,
      '--namespace',
      'demo',
      '--kind',
      'note',
      '--content',
      'hello',
      '--json',
    ]);
    assert.equal(create.status, 0, create.stderr);
    assert.equal(create.stderr, '');
    const outcome = JSON.parse(create.stdout);
    assert.equal(outcome.history, 'persisted', 'Git history is the default');

    const get = runCli(['get', outcome.memory.id, '--store', store, '--json']);
    assert.equal(get.status, 0, get.stderr);
    assert.deepEqual(JSON.parse(get.stdout), outcome.memory);

    const human = runCli(['get', outcome.memory.id, '--store', store]);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /state:\s+active/);
    assert.match(human.stdout, /hello\n$/);
  });

  it('S1.4 an unknown id exits 1 with problem JSON on stderr', () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    const id = newMemoryId();
    const get = runCli(['get', id, '--store', store, '--json']);
    assert.equal(get.status, 1);
    assert.equal(get.stdout, '');
    const problem = JSON.parse(get.stderr);
    assert.equal(problem.code, 'NotFound');
    assert.equal(problem.status, 404);
    assert.equal(problem.type, 'urn:memorykit:error:NotFound');
    assert.equal(problem.retryable, false);
    assert.deepEqual(problem.details, { id });
  });

  it('domain errors exit 1 and usage errors exit 2', () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    const invalid = runCli([
      'create',
      '--store',
      store,
      '--namespace',
      'Demo',
      '--kind',
      'note',
      '--content',
      'x',
    ]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).code, 'ValidationFailed');

    assert.equal(runCli([]).status, 2);
    assert.equal(runCli(['frobnicate']).status, 2);
    assert.equal(runCli(['get', '--store', store]).status, 2);
    assert.equal(
      runCli(['create', '--store', store, '--kind', 'note', '--content', 'x']).status,
      2
    );
    assert.equal(runCli(['get', newMemoryId(), '--store', store, '--bogus']).status, 2);
    assert.equal(runCli(['--help']).status, 0);
  });

  it('S2.6 update through the CLI, with its usage errors', () => {
    const store = tempDir();
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
      'v1',
      '--json',
    ]);
    const id = JSON.parse(created.stdout).memory.id as string;
    const update = (...args: string[]) => runCli(['update', id, '--store', store, ...args]);

    const human = update('--expected-revision', '1', '--content', 'v2');
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /revision 2 active/);
    const conflict = update('--expected-revision', '1', '--content', 'v3');
    assert.equal(conflict.status, 1);
    assert.deepEqual(JSON.parse(conflict.stderr).details, { id, currentRevision: 2 });
    assert.equal(JSON.parse(update('--expected-revision', 'two').stderr).code, 'ValidationFailed');
    assert.equal(update('--content', 'x').status, 2);
    assert.equal(update('--expected-revision', '2', '--namespace', 'other').status, 2);
    assert.equal(runCli(['update', '--store', store, '--expected-revision', '2']).status, 2);
  });

  it('provenance on create, update, supersede and transitions, refused on purge and search', () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    const provenance = {
      origin: { kind: 'agent', name: 'claude-code', version: '2.1' },
      reason: 'chosen in review',
      evidence: [{ ref: 'git:abc123:design/10-design.md', note: 'section 4' }],
    };
    const created = runCli([
      'create',
      '--store',
      store,
      '--namespace',
      'demo',
      '--kind',
      'decision',
      '--content',
      'v1',
      '--provenance',
      JSON.stringify(provenance),
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const id = JSON.parse(created.stdout).memory.id as string;
    const read = () => JSON.parse(runCli(['get', id, '--store', store, '--json']).stdout);
    assert.deepEqual(read().provenance, provenance);

    const updated = { reason: 'reworded', evidence: [] };
    const update = runCli([
      'update',
      id,
      '--store',
      store,
      '--expected-revision',
      '1',
      '--content',
      'v2',
      '--provenance',
      JSON.stringify(updated),
    ]);
    assert.equal(update.status, 0, update.stderr);
    assert.deepEqual(read().provenance, updated);

    const archived = { reason: 'replaced soon', evidence: [] };
    const archive = runCli([
      'archive',
      id,
      '--store',
      store,
      '--expected-revision',
      '2',
      '--provenance',
      JSON.stringify(archived),
    ]);
    assert.equal(archive.status, 0, archive.stderr);
    assert.deepEqual(read().provenance, archived);
    assert.equal(runCli(['restore', id, '--store', store, '--expected-revision', '3']).status, 0);

    const correction = { reason: 'corrected', evidence: [{ ref: `memory:${id}` }] };
    const superseded = runCli([
      'supersede',
      id,
      '--store',
      store,
      '--expected-revision',
      '4',
      '--kind',
      'decision',
      '--content',
      'v3',
      '--provenance',
      JSON.stringify(correction),
      '--json',
    ]);
    assert.equal(superseded.status, 0, superseded.stderr);
    assert.deepEqual(JSON.parse(superseded.stdout).memory.provenance, correction);

    // Bad JSON and unknown fields are domain errors; purge and search refuse the flag.
    const invalid = (text: string) =>
      runCli([
        'create',
        '--store',
        store,
        '--namespace',
        'demo',
        '--kind',
        'note',
        '--content',
        'x',
        '--provenance',
        text,
      ]);
    const notJson = invalid('{');
    assert.equal(notJson.status, 1);
    assert.equal(JSON.parse(notJson.stderr).details.field, 'provenance');
    const unknown = invalid('{"author": "x"}');
    assert.equal(unknown.status, 1);
    assert.equal(JSON.parse(unknown.stderr).code, 'ValidationFailed');
    const purge = runCli([
      'purge',
      id,
      '--store',
      store,
      '--expected-revision',
      '5',
      '--provenance',
      '{}',
    ]);
    assert.equal(purge.status, 2);
    assert.equal(runCli(['search', '--store', store, '--provenance', '{}']).status, 2);
  });

  it('S3.2 a write with history pending exits 3, and history-sync reports the queue', async () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    const history = new FailingHistory();
    let historyWaitMs = 0;
    const deps: CliDeps = {
      async openStore(config) {
        const service = new MemoryService(
          new SqliteStorage({ path: join(config.path, DATABASE_FILE) }),
          history,
          { historyWaitMs }
        );
        await service.open();
        return Object.assign(service.as(EMBEDDED_PRINCIPAL), { close: () => service.close() });
      },
    };
    const cli = async (...args: string[]) => {
      const out = { stdout: '', stderr: '' };
      const status = await run(
        args,
        { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
        deps
      );
      return { status, ...out };
    };

    const create = await cli(
      'create',
      '--store',
      store,
      '--namespace',
      'demo',
      '--kind',
      'note',
      '--content',
      'x',
      '--json'
    );
    assert.equal(create.status, 3, create.stderr);
    const outcome = JSON.parse(create.stdout);
    assert.equal(outcome.storage, 'persisted');
    assert.equal(outcome.history, 'pending');

    const operation = await cli('operation', outcome.operationId, '--store', store);
    assert.equal(operation.status, 0, operation.stderr);
    assert.match(operation.stdout, /\(history: pending\)/);
    const pending = await cli('history-sync', '--store', store, '--budget-ms', '1000');
    assert.equal(pending.status, 3, pending.stderr);
    assert.match(pending.stdout, /history pending: 1/);
    assert.equal((await cli('history-sync', '--store', store, '--budget-ms', 'x')).status, 1);

    history.failing = false;
    const synced = await cli('history-sync', '--store', store, '--json');
    assert.equal(synced.status, 0, synced.stderr);
    assert.deepEqual(JSON.parse(synced.stdout), { pending: 0, blocked: null, lastError: null });
    const listed = await cli('history', outcome.memory.id, '--store', store);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^1 {2}create /);
    const revision = await cli('revision', outcome.memory.id, '1', '--store', store);
    assert.equal(revision.status, 0, revision.stderr);
    assert.match(revision.stdout, /^revision 1 create by embedded/);
    assert.match(revision.stdout, /x\n$/);
    const status = await cli('status', '--store', store);
    assert.match(status.stdout, /history: history-memory 0\.1\.0/);
    assert.match(status.stdout, /history blocked: none/);

    history.failing = true;
    history.retryable = false;
    historyWaitMs = 5000;
    const blocked = await cli(
      'update',
      outcome.memory.id,
      '--store',
      store,
      '--expected-revision',
      '1',
      '--content',
      'y',
      '--json'
    );
    assert.equal(JSON.parse(blocked.stdout).history, 'blocked');
    assert.equal(blocked.status, 3, 'a blocked write exits 3 too');
  });

  it('status, namespace and history commands', () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    const status = runCli(['status', '--store', store, '--json']);
    assert.equal(status.status, 0, status.stderr);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.contractVersion, 1);
    assert.equal(parsed.storage.id, 'storage-sqlite');
    assert.equal(parsed.history.id, 'history-git');
    assert.deepEqual(parsed.historyQueue, { pending: 0, blocked: null, lastError: null });

    const set = runCli([
      'namespace',
      'set',
      'demo',
      '--history-policy',
      'metadata',
      '--store',
      store,
    ]);
    assert.equal(set.status, 0, set.stderr);
    assert.equal(set.stdout, 'demo history policy: metadata\n');
    const get = runCli(['namespace', 'get', 'demo', '--store', store, '--json']);
    assert.deepEqual(JSON.parse(get.stdout), { name: 'demo', historyPolicy: 'metadata' });
    const invalid = runCli([
      'namespace',
      'set',
      'demo',
      '--history-policy',
      'some',
      '--store',
      store,
    ]);
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stderr).details.reason, 'unsupported');
    assert.equal(runCli(['namespace', 'set', 'demo', '--store', store]).status, 2);
    assert.equal(runCli(['namespace', 'drop', 'demo', '--store', store]).status, 2);
    assert.equal(
      runCli(['namespace', 'get', 'demo', '--history-policy', 'none', '--store', store]).status,
      2
    );

    assert.equal(
      runCli(['namespace', 'set', 'demo', '--history-policy', 'none', '--store', store]).status,
      0
    );
    const created = runCli([
      'create',
      '--store',
      store,
      '--namespace',
      'demo',
      '--kind',
      'note',
      '--content',
      'x',
      '--json',
    ]);
    assert.equal(created.status, 0, created.stderr);
    const { memory, operationId } = JSON.parse(created.stdout);
    const history = runCli(['history', memory.id, '--store', store]);
    assert.equal(history.status, 1);
    assert.equal(JSON.parse(history.stderr).code, 'HistoryNotRetained');
    const operation = runCli(['operation', operationId, '--store', store, '--json']);
    assert.equal(JSON.parse(operation.stdout).history, 'not_required');
    assert.equal(runCli(['history-sync', '--store', store]).status, 0);
    assert.equal(runCli(['revision', memory.id, '--store', store]).status, 2);
  });

  it('search prints one line per memory and the cursor, with its usage errors', () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    for (const content of ['lighthouse one\nsecond line', 'lighthouse two']) {
      const args = ['create', '--store', store, '--namespace', 'demo', '--kind', 'note'];
      assert.equal(runCli([...args, '--content', content]).status, 0);
    }
    const page = runCli(['search', '--store', store, '--text', 'lighthouse', '--limit', '1']);
    assert.equal(page.status, 0, page.stderr);
    const lines = page.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\S+ {2}demo {2}note {2}active {2}lighthouse (one|two)$/);
    assert.match(lines[1]!, /^next cursor: \S+$/);
    const none = runCli(['search', '--store', store, '--text', 'fog']);
    assert.equal(none.stdout, 'No memories found\n');
    assert.equal(runCli(['search', '--store', store, '--content', 'x']).status, 2);
    assert.equal(runCli(['search', 'extra', '--store', store]).status, 2);
    const limit = runCli(['search', '--store', store, '--limit', 'ten']);
    assert.equal(JSON.parse(limit.stderr).code, 'ValidationFailed');
    const twice = ['--store', store, '--kind', 'a', '--kind', 'b', '--content', 'x'];
    assert.equal(runCli(['create', '--namespace', 'demo', ...twice]).status, 2);
  });

  it('search rejects unused write flags before opening a store or connecting', async () => {
    for (const flag of ['operation-id', 'expected-revision', 'budget-ms']) {
      for (const target of [
        ['--store', 'unused'],
        ['--url', 'http://localhost:1'],
      ]) {
        let stdout = '';
        let stderr = '';
        const status = await run(
          ['search', ...target, `--${flag}`, '1'],
          { stdout: (text) => (stdout += text), stderr: (text) => (stderr += text) },
          {
            openStore: async () => assert.fail('must not open a store'),
            connect: () => assert.fail('must not connect'),
          }
        );
        assert.equal(status, 2, stderr);
        assert.equal(stdout, '');
        assert.ok(stderr.startsWith(`search does not take --${flag}\n\nUsage:`), stderr);
      }
    }
  });

  it('S1.6 refuses a schema newer than the code', () => {
    const store = tempDir();
    assert.equal(runCli(['init', store]).status, 0);
    const db = new DatabaseSync(join(store, 'memory.db'));
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    db.close();
    const result = runCli(['get', newMemoryId(), '--store', store]);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).code, 'StoreVersionTooNew');
  });
});
