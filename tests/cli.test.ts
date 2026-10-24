import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { newMemoryId } from '../src/model/index.ts';
import { SCHEMA_VERSION } from '../src/storage-sqlite/schema.ts';
import { runCli, tempDir } from './helpers.ts';

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
    assert.equal(outcome.history, 'not_required');

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
