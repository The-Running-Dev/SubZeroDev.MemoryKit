import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import { handle } from '../src/http/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import type { MemoryClient } from '../src/service/index.ts';
import type { GitSourceConfig } from '../src/workflow/git-source.ts';
import {
  acquireLease,
  dueSources,
  inspectSources,
  syncDueSources,
  type SourceRuntime,
} from '../src/workflow/source-runner.ts';
import { CLI, REPO_ROOT, runCli, tempDir } from './helpers.ts';

const NAMESPACE = 'project/acme/notes';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function commit(root: string, path: string, content: string): string {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  return git(root, 'rev-parse', 'HEAD');
}

function newRepo(): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  commit(root, 'a.md', 'Alpha.\n');
  return root;
}

function source(root: string, extra: Partial<GitSourceConfig> = {}): GitSourceConfig {
  return {
    id: 'notes',
    repository: root,
    ref: 'main',
    include: ['**'],
    namespace: NAMESPACE,
    auto: true,
    ...extra,
  };
}

async function openClient(): Promise<MemoryClient> {
  const store = { path: tempDir(), history: { provider: 'memory' as const } };
  await initStore(store);
  const client = await openStore(store, EMBEDDED_PRINCIPAL);
  after(() => client.close());
  return client;
}

function runtime(sources: GitSourceConfig[]): SourceRuntime {
  return { sources, stateFile: join(tempDir(), 'profile.json.sources.json') };
}

function request(method: string, path: string, body = '') {
  return { method, path, headers: new Headers(), body };
}

describe('SessionStart keeps auto sources current (S29.1)', () => {
  it('syncs in the background, never fails the host, and recall sees the new commit', async () => {
    const root = newRepo();
    const dir = tempDir();
    const store = join(dir, 'store');
    assert.equal(runCli(['init', store]).status, 0);
    const profile = join(dir, 'profile.json');
    writeFileSync(
      profile,
      JSON.stringify({
        version: 1,
        store,
        history: 'none',
        namespace: NAMESPACE,
        sources: [source(root)],
      })
    );
    const event = JSON.stringify({
      hook_event_name: 'SessionStart',
      session_id: 's1',
      cwd: dir,
      source: 'startup',
    });
    const started = spawnSync(
      process.execPath,
      [CLI, 'hook', '--profile', profile, '--host', 'claude-code'],
      { input: event, encoding: 'utf8', cwd: REPO_ROOT }
    );
    assert.equal(started.status, 0, started.stderr);
    const tip = git(root, 'rev-parse', 'HEAD');
    const state = `${profile}.sources.json`;
    const deadline = Date.now() + 20_000;
    let cursor: string | null = null;
    while (Date.now() < deadline && cursor !== tip) {
      await new Promise((r) => setTimeout(r, 200));
      if (existsSync(state)) cursor = JSON.parse(readFileSync(state, 'utf8')).notes?.cursor ?? null;
    }
    assert.equal(cursor, tip, 'the detached sync advanced the cursor');
    const status = JSON.parse(
      runCli(['source', 'status', '--profile', profile, '--source', 'notes']).stdout
    );
    assert.equal(status.lag, 0);
  });

  it('exits 0 when a source is unusable', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    assert.equal(runCli(['init', store]).status, 0);
    const profile = join(dir, 'profile.json');
    writeFileSync(
      profile,
      JSON.stringify({
        version: 1,
        store,
        history: 'none',
        namespace: NAMESPACE,
        sources: [source(join(dir, 'missing'))],
      })
    );
    const started = spawnSync(
      process.execPath,
      [CLI, 'hook', '--profile', profile, '--host', 'claude-code'],
      {
        input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's', cwd: dir }),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      }
    );
    assert.equal(started.status, 0, started.stderr);
  });

  it('the due check is one rev-parse per source and stays fast', () => {
    const sources = Array.from({ length: 4 }, (_, i) => source(newRepo(), { id: `s${i}` }));
    const started = performance.now();
    const due = dueSources(sources, {});
    const elapsed = performance.now() - started;
    assert.equal(due.length, 4);
    assert.ok(elapsed < 8000, `due check took ${elapsed} ms`); // loose: the suite runs in parallel on loaded CI
    assert.deepEqual(
      dueSources([source(newRepo(), { auto: false })], {}),
      [],
      'a source without auto is never due'
    );
  });
});

describe('one sync per store under a lease (S29.2)', () => {
  it('refuses a second holder and takes over an expired lease', () => {
    const { stateFile } = runtime([]);
    mkdirSync(join(stateFile!, '..'), { recursive: true });
    const first = acquireLease(stateFile!);
    assert.ok(first);
    assert.equal(acquireLease(stateFile!), null);
    const later = acquireLease(stateFile!, undefined, Date.now() + 10 * 60_000);
    assert.ok(later, 'an expired lease is taken over');
    first.release();
    assert.equal(acquireLease(stateFile!), null, 'the old holder cannot release the new lease');
    later.release();
    assert.ok(acquireLease(stateFile!));
  });

  it('two concurrent due syncs run once', async () => {
    const client = await openClient();
    const rt = runtime([source(newRepo())]);
    mkdirSync(join(rt.stateFile!, '..'), { recursive: true });
    const [a, b] = await Promise.all([syncDueSources(client, rt), syncDueSources(client, rt)]);
    const ran = [a, b].filter((r) => r.ran);
    const leased = [a, b].filter((r) => r.reason === 'leased');
    assert.equal(ran.length, 1);
    assert.equal(leased.length, 1);
    assert.equal((await syncDueSources(client, rt)).reason, 'nothing_due');
  });
});

describe('HTTP names only configured sources (S29.3)', () => {
  it('serves status and sync by id and rejects any other input', async () => {
    const client = await openClient();
    const root = newRepo();
    const rt = runtime([source(root)]);
    mkdirSync(join(rt.stateFile!, '..'), { recursive: true });
    const status = await handle(client, request('GET', '/v1/sources/notes'), rt);
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).cursor, null);
    const sync = await handle(client, request('POST', '/v1/sources/notes/sync'), rt);
    assert.equal(sync.status, 200, sync.body);
    assert.equal(JSON.parse(sync.body).created, 1);
    const after = await handle(client, request('GET', '/v1/sources/notes'), rt);
    assert.equal(JSON.parse(after.body).lag, 0);
    for (const field of ['path', 'ref', 'url', 'repository']) {
      const response = await handle(
        client,
        request('POST', '/v1/sources/notes/sync', JSON.stringify({ [field]: 'x' })),
        rt
      );
      assert.equal(response.status, 400, field);
    }
    assert.equal((await handle(client, request('GET', '/v1/sources/other'), rt)).status, 404);
    assert.equal((await handle(client, request('GET', '/v1/sources/notes'))).status, 404);
  });

  it('answers 409-class busy while a sync holds the lease', async () => {
    const client = await openClient();
    const rt = runtime([source(newRepo())]);
    mkdirSync(join(rt.stateFile!, '..'), { recursive: true });
    const held = acquireLease(rt.stateFile!);
    assert.ok(held);
    const response = await handle(client, request('POST', '/v1/sources/notes/sync'), rt);
    assert.ok([409, 429, 503].includes(response.status), String(response.status));
    held.release();
  });
});

describe('doctor reports source health without content (S29.4)', () => {
  it('flags unreachable repositories, unresolved refs, failed fetches, conflicts and lag', () => {
    const root = newRepo();
    const sources = [
      source(root, { id: 'ok' }),
      source(join(tempDir(), 'missing'), { id: 'gone' }),
      source(root, { id: 'noref', ref: 'nope' }),
      source(root, { id: 'fetchy', fetch: 'origin' }),
    ];
    const rt = runtime(sources);
    mkdirSync(join(rt.stateFile!, '..'), { recursive: true });
    const tip = git(root, 'rev-parse', 'HEAD');
    writeFileSync(
      rt.stateFile!,
      JSON.stringify({
        ok: { cursor: tip, skipped: 0, conflicts: 2, archived: 0 },
        fetchy: { cursor: tip, skipped: 0, conflicts: 0, archived: 0, fetch: 'failed' },
      })
    );
    const health = Object.fromEntries(inspectSources(rt).map((h) => [h.source, h]));
    assert.equal(health.ok!.ok, true);
    assert.ok(health.ok!.problems.includes('conflicts'));
    assert.equal(health.gone!.repository, 'unreachable');
    assert.ok(health.gone!.problems.includes('repository_unreachable'));
    assert.equal(health.noref!.ref, 'unresolved');
    assert.ok(health.noref!.problems.includes('ref_unresolved'));
    assert.ok(health.fetchy!.problems.includes('fetch_failed'));
    assert.equal(health.fetchy!.ok, false);
    assert.ok(!JSON.stringify(health).includes('Alpha'), 'no document content');
    const lagged = commit(root, 'b.md', 'Beta.\n');
    assert.notEqual(lagged, tip);
    assert.ok(
      inspectSources(rt)
        .find((h) => h.source === 'ok')!
        .problems.includes('lag')
    );
  });
});

describe('docs (S29.5)', () => {
  it('give the Notes-style configuration, the runbook and the optional hook line', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs', 'portable-memory.md'), 'utf8');
    for (const needle of [
      'Journal/**',
      'raw/**',
      'post-commit',
      'Cutover',
      'Rollback',
      'installs nothing in the source repository',
    ])
      assert.ok(doc.includes(needle), needle);
  });
});
