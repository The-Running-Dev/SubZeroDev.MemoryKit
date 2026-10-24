import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { newMemoryId } from '../src/model/index.ts';
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
});
