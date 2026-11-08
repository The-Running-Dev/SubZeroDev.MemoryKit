import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { it } from 'node:test';
import { tempDir } from './helpers.ts';

const adapter = fileURLToPath(new URL('../examples/codex-recall.mjs', import.meta.url));
const { codexProcess } = await import(new URL('../examples/codex-process.mjs', import.meta.url).href);

function fixture() {
  const home = tempDir(), file = join(home, 'native.mjs');
  // Node preloads this in both processes; only the simulated native CLI handles "exec".
  writeFileSync(file, `
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
if (basename(process.argv[1]) === 'exec') {
  let raw = ''; for await (const chunk of process.stdin) raw += chunk;
  const home = process.env.CODEX_HOME;
  const cached = existsSync(join(home, 'models_cache.json'));
  writeFileSync(process.env.INSPECT, JSON.stringify({
    home, files: readdirSync(home), config: readFileSync(join(home, 'config.toml'), 'utf8'),
    cache: cached ? readFileSync(join(home, 'models_cache.json'), 'utf8') : null, args: process.argv,
  }));
  console.log(JSON.stringify({type:'thread.started'}));
  console.log(JSON.stringify({type:'turn.started'}));
  const request = raw.startsWith('{') ? JSON.parse(raw) : null;
  const answer = request ? {matches:[0]} : {queries:['bicycle']};
  writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1], JSON.stringify(answer));
  console.log(JSON.stringify({type:'turn.completed'}));
  if (process.env.BAD_EVENT) console.log(process.env.BAD_EVENT);
  process.exit(0);
}
`);
  const cache = JSON.stringify({ fetched_at: 'unchanged', client_version: 'test', models: [] });
  writeFileSync(join(home, 'auth.json'), '{}');
  writeFileSync(join(home, 'models_cache.json'), cache);
  writeFileSync(join(home, 'config.toml'), 'PRIVATE_GLOBAL_SETTINGS');
  writeFileSync(join(home, 'AGENTS.md'), 'PRIVATE_HOST_RULES');
  const timings = join(home, 'timings.jsonl'), inspect = join(home, 'inspect.json');
  const env = { ...process.env, CODEX_HOME: home, INSPECT: inspect, BAD_EVENT: '',
    NODE_OPTIONS: `--import=${pathToFileURL(file).href}` };
  const run = (args: string[] = [], input = {version: 1, task: 'expand', query: 'PRIVATE_QUERY'}) => {
    const result = spawnSync(process.execPath, [adapter, '--codex', process.execPath,
      '--timings', timings, ...args], { env, input: JSON.stringify(input), encoding: 'utf8' });
    return { ...result, timing: JSON.parse(readFileSync(timings, 'utf8').trim().split('\n').at(-1)!),
      inspected: JSON.parse(readFileSync(inspect, 'utf8')) };
  };
  return { home, cache, env, run };
}

it('seeds only catalog metadata and auth in an ephemeral isolated home', () => {
  const f = fixture(), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { queries: ['bicycle'] });
  assert.equal(result.inspected.cache, f.cache);
  assert.deepEqual(result.inspected.files.sort(), ['auth.json', 'config.toml', 'instructions.txt', 'models_cache.json', 'schema.json']);
  assert.doesNotMatch(result.inspected.config, /PRIVATE_GLOBAL_SETTINGS/);
  assert.match(result.inspected.config, /shell_tool = false/);
  assert.ok(result.inspected.args.includes('--ephemeral'));
  assert.ok(result.inspected.args.includes('--ignore-rules'));
  assert.equal(existsSync(result.inspected.home), false);
  assert.equal(readFileSync(join(f.home, 'models_cache.json'), 'utf8'), f.cache);
  assert.equal(result.timing.catalogCopied, true);
  assert.equal(result.timing.succeeded, true);
  assert.ok(result.timing.spawnMs <= result.timing.threadStartedMs);
  assert.ok(result.timing.turnStartedMs <= result.timing.turnCompletedMs);
  assert.ok(result.timing.processMs <= result.timing.adapterMs);
  assert.doesNotMatch(JSON.stringify(result.timing), /PRIVATE_QUERY|bicycle|auth|thread_id/);
  const fresh = f.run(['--fresh-model-catalog']);
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.inspected.cache, null);
  assert.equal(fresh.timing.catalogCopied, false);
  assert.equal(fresh.stdout, result.stdout);
});

it('falls back when optional model catalog metadata is absent or oversized', () => {
  const f = fixture();
  writeFileSync(join(f.home, 'models_cache.json'), 'x'.repeat(8 * 1024 * 1024 + 1));
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.timing.catalogCopied, false);
  const missing = fixture();
  missing.env.CODEX_HOME = tempDir();
  writeFileSync(join(missing.env.CODEX_HOME, 'auth.json'), '{}');
  assert.equal(missing.run().timing.catalogCopied, false);
});

it('retains compact identities and independent verification with seeded metadata', () => {
  const f = fixture();
  for (const task of ['select', 'verify']) {
    const input = { version: 1, task, query: 'Where is the bicycle?', limit: 1,
      passages: [{ id: 'one', revision: 4, namespace: 'demo', content: 'Bicycle in attic.' }],
      ...(task === 'verify' ? { selections: [{ id: 'one', revision: 4, quote: 'Bicycle' }] } : {}) };
    const result = f.run([], input);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { selections: [{id: 'one', revision: 4, quote: 'Bicycle in attic.'}] });
  }
});

it('still rejects late error, tool and malformed events after a completed turn', () => {
  const f = fixture();
  for (const event of ['{"type":"error"}', '{"item":{"type":"command_execution"}}', 'invalid-json']) {
    f.env.BAD_EVENT = event;
    const result = f.run();
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.timing.succeeded, false);
    assert.equal(existsSync(result.inspected.home), false);
  }
});

it('bounds asynchronous native execution and stdout/stderr without exposing them', async () => {
  for (const code of ["process.stdout.write('x'.repeat(1048577))", "process.stderr.write('private'.repeat(200000))"]) {
    const result = await codexProcess(process.execPath, ['-e', code], { input: '', timeout: 5000 });
    assert.equal(result.error?.code, 'OUTPUT_LIMIT');
  }
  const timed = await codexProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {input: '', timeout: 100});
  assert.equal(timed.error.code, 'ETIMEDOUT');
  const missing = await codexProcess(join(tempDir(), 'missing-executable'), [], {input:'', timeout:1000});
  assert.equal(missing.error.code, 'SPAWN_FAILED');
});
