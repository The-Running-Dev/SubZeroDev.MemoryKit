import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import type { MemoryClient } from '../src/service/index.ts';
import {
  gitSourceStatus,
  syncGitSource,
  type GitSourceConfig,
} from '../src/workflow/git-source.ts';
import { runCli, tempDir } from './helpers.ts';

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

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function commit(root: string, message: string): string {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function newRepo(files: Record<string, string>): string {
  const root = tempDir();
  git(root, 'init', '-q', '-b', 'main');
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  commit(root, 'first');
  return root;
}

function config(root: string, extra: Partial<GitSourceConfig> = {}): GitSourceConfig {
  return {
    id: 'notes',
    repository: root,
    ref: 'main',
    include: ['**'],
    namespace: NAMESPACE,
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

async function active(client: MemoryClient): Promise<Record<string, string>> {
  const found = await client.search({ namespaces: [NAMESPACE], limit: 100 });
  return Object.fromEntries(found.items.map((r) => [r.key!, r.content]).sort());
}

async function byKey(
  client: MemoryClient,
  key: string,
  states = ['active', 'archived', 'superseded']
) {
  const found = await client.search({
    namespaces: [NAMESPACE],
    states: states as never,
    limit: 100,
  });
  const record = found.items.find((r) => r.key === key);
  assert.ok(record, `record ${key}`);
  return record;
}

const key = (path: string) => `git:notes:${path}`;

describe('git source follows later commits (S28.1)', () => {
  it('updates, supersedes a rename and archives a deletion, with the causing commit in history', async () => {
    const root = newRepo({
      'a.md': 'Alpha original text.\n',
      'b.md': 'Beta text that moves.\n',
      'c.md': 'Gamma text that goes away.\n',
    });
    const client = await openClient();
    const first = await syncGitSource(client, config(root));
    assert.equal(first.created, 3);
    write(root, 'a.md', 'Alpha edited text.\n');
    commit(root, 'edit a');
    git(root, 'mv', 'b.md', 'b2.md');
    commit(root, 'rename b');
    git(root, 'rm', '-q', 'c.md');
    const tip = commit(root, 'delete c');

    const second = await syncGitSource(client, config(root), { cursor: first.cursor });
    assert.equal(second.completeness, 'complete');
    assert.deepEqual(
      [second.updated, second.superseded, second.archived, second.created, second.conflicts.length],
      [1, 1, 1, 0, 0]
    );
    assert.deepEqual(await active(client), {
      [key('a.md')]: 'Alpha edited text.\n',
      [key('b2.md')]: 'Beta text that moves.\n',
    });
    const a = await byKey(client, key('a.md'));
    assert.equal(a.revision, 2);
    assert.equal((await client.history(a.id)).length, 2);
    assert.match(
      JSON.stringify((await client.revision(a.id, 2)).record.provenance),
      new RegExp(tip)
    );
    assert.equal((await byKey(client, key('b.md'))).state, 'superseded');
    const c = await byKey(client, key('c.md'));
    assert.equal(c.state, 'archived');
    assert.match(JSON.stringify(c.provenance), new RegExp(tip));

    const repeat = await syncGitSource(client, config(root), { cursor: second.cursor });
    assert.deepEqual(
      [repeat.created, repeat.updated, repeat.superseded, repeat.archived, repeat.unchanged],
      [0, 0, 0, 0, 2]
    );
  });

  it('follows a renamed file that was also edited, through the cursor rename pair', async () => {
    const body = 'Shared line.\n'.repeat(40);
    const root = newRepo({ 'old.md': `${body}tail one\n` });
    const client = await openClient();
    const first = await syncGitSource(client, config(root));
    git(root, 'mv', 'old.md', 'new.md');
    write(root, 'new.md', `${body}tail two\n`);
    commit(root, 'rename and edit');
    const next = await syncGitSource(client, config(root), { cursor: first.cursor });
    assert.deepEqual([next.superseded, next.created, next.archived], [1, 0, 0]);
    assert.equal((await byKey(client, key('old.md'))).state, 'superseded');
  });
});

describe('git source keeps local curation (S28.2, S28.3)', () => {
  it('reports a conflict for a corrected record and leaves its content and revision', async () => {
    const root = newRepo({ 'a.md': 'Alpha original.\n' });
    const client = await openClient();
    await syncGitSource(client, config(root));
    const before = await byKey(client, key('a.md'));
    const corrected = await client.update({
      id: before.id,
      expectedRevision: before.revision,
      content: 'Alpha corrected by a person.\n',
    });
    write(root, 'a.md', 'Alpha changed upstream.\n');
    commit(root, 'upstream edit');
    const result = await syncGitSource(client, config(root));
    assert.deepEqual(result.conflicts, [{ key: key('a.md'), reason: 'changed' }]);
    assert.equal(result.updated, 0);
    const after = await byKey(client, key('a.md'));
    assert.equal(after.content, 'Alpha corrected by a person.\n');
    assert.equal(after.revision, corrected.memory.revision);
    assert.equal(result.completeness, 'complete');
  });

  it('reports a deleted file whose record was corrected, instead of archiving it', async () => {
    const root = newRepo({ 'a.md': 'Alpha original.\n', 'b.md': 'Beta.\n' });
    const client = await openClient();
    await syncGitSource(client, config(root));
    const a = await byKey(client, key('a.md'));
    await client.update({ id: a.id, expectedRevision: a.revision, content: 'Alpha fixed.\n' });
    git(root, 'rm', '-q', 'a.md');
    commit(root, 'delete a');
    const result = await syncGitSource(client, config(root));
    assert.deepEqual(result.conflicts, [{ key: key('a.md'), reason: 'deleted' }]);
    assert.equal((await byKey(client, key('a.md'))).state, 'active');
  });

  it('re-queues a changed record from a candidate source and keeps an accepted source accepted', async () => {
    for (const status of ['candidate', 'accepted'] as const) {
      const root = newRepo({ 'a.md': 'Alpha original.\n' });
      const client = await openClient();
      const cfg = config(root, { status });
      await syncGitSource(client, cfg);
      const record = await byKey(client, key('a.md'));
      let current = record;
      if (status === 'candidate') {
        const accepted = await client.update({
          id: record.id,
          expectedRevision: record.revision,
          metadata: { ...record.metadata, status: 'accepted' },
        });
        current = accepted.memory;
        // A review decision stays when nothing changed upstream.
        const same = await syncGitSource(client, cfg);
        assert.equal(same.updated, 0);
        assert.equal((await byKey(client, key('a.md'))).metadata.status, 'accepted');
      }
      write(root, 'a.md', 'Alpha changed upstream.\n');
      commit(root, 'upstream edit');
      const result = await syncGitSource(client, cfg);
      assert.equal(result.updated, 1);
      const after = await byKey(client, key('a.md'));
      assert.equal(after.content, 'Alpha changed upstream.\n');
      assert.equal(after.metadata.status, status);
      assert.equal(after.revision, current.revision + 1);
    }
  });
});

describe('git source recovers from a force push (S28.4)', () => {
  it('reconciles to the new tip, equal to a fresh import and without duplicates', async () => {
    const root = newRepo({ 'a.md': 'Alpha.\n', 'b.md': 'Beta.\n' });
    write(root, 'c.md', 'Gamma.\n');
    commit(root, 'add c');
    const client = await openClient();
    const first = await syncGitSource(client, config(root));
    assert.equal(first.created, 3);
    // Drop the cursor commit and publish different history.
    git(root, 'reset', '-q', '--hard', 'HEAD~1');
    write(root, 'b.md', 'Beta rewritten.\n');
    write(root, 'd.md', 'Delta.\n');
    commit(root, 'forced');
    const status = gitSourceStatus(config(root), first.state);
    assert.equal(status.cursorReachable, false);
    assert.equal(status.lag, null);
    const next = await syncGitSource(client, config(root), { cursor: first.cursor });
    assert.equal(next.completeness, 'complete');

    const fresh = await openClient();
    await syncGitSource(fresh, config(root));
    assert.deepEqual(await active(client), await active(fresh));
    assert.deepEqual(Object.keys(await active(client)), [key('a.md'), key('b.md'), key('d.md')]);
  });
});

describe('git source bounds (S28.5)', () => {
  it('returns partial with the cursor unchanged, then completes to the unbounded result', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [`n${i}.md`, `Note number ${i}.\n`])
    );
    const root = newRepo(files);
    const client = await openClient();
    const partial = await syncGitSource(client, config(root), { cursor: null, maxChanges: 2 });
    assert.equal(partial.completeness, 'partial');
    assert.equal(partial.cursor, null);
    assert.equal(partial.created, 2);
    const done = await syncGitSource(client, config(root), { cursor: partial.cursor });
    assert.equal(done.completeness, 'complete');
    assert.equal(done.created, 3);
    assert.equal(done.unchanged, 2);

    const unbounded = await openClient();
    await syncGitSource(unbounded, config(root));
    assert.deepEqual(await active(client), await active(unbounded));
  });

  it('never archives anything when the blob budget cut the plan short', async () => {
    const root = newRepo({ 'a.md': 'Alpha text here.\n', 'b.md': 'Beta text here.\n' });
    const client = await openClient();
    await syncGitSource(client, config(root));
    const cut = await syncGitSource(client, config(root), { maxBlobBytes: 20 });
    assert.equal(cut.archived, 0);
    assert.equal(Object.keys(await active(client)).length, 2);
  });
});

describe('git source status (S28.6)', () => {
  it('reports ref, last commit, lag and counts without document content', async () => {
    const root = newRepo({ 'a.md': 'Alpha secret-free text.\n', 'p.png': 'not text' });
    const client = await openClient();
    const synced = await syncGitSource(client, config(root));
    write(root, 'a.md', 'Alpha edited with unique-marker-text.\n');
    commit(root, 'two');
    write(root, 'x.md', 'Extra.\n');
    const tip = commit(root, 'three');
    const status = gitSourceStatus(config(root), synced.state);
    assert.equal(status.ref, 'main');
    assert.equal(status.commit, tip);
    assert.equal(status.cursor, synced.commit);
    assert.equal(status.lag, 2);
    assert.equal(status.skipped, 1);
    assert.equal(status.conflicts, 0);
    assert.equal(status.archived, 0);
    assert.ok(!JSON.stringify(status).includes('unique-marker-text'));
    assert.equal(gitSourceStatus(config(root)).lag, null);
  });

  it('is available through the CLI and persists the cursor beside the profile', () => {
    const root = newRepo({ 'a.md': 'Alpha.\n' });
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
        sources: [config(root)],
      })
    );
    const args = ['--profile', profile, '--source', 'notes'];
    const before = JSON.parse(runCli(['source', 'status', ...args]).stdout);
    assert.equal(before.cursor, null);
    const sync = runCli(['source', 'sync', ...args]);
    assert.equal(sync.status, 0, sync.stderr);
    write(root, 'b.md', 'Beta.\n');
    commit(root, 'two');
    const mid = JSON.parse(runCli(['source', 'status', ...args]).stdout);
    assert.equal(mid.lag, 1);
    assert.equal(mid.cursorReachable, true);
    const again = JSON.parse(runCli(['source', 'sync', ...args]).stdout);
    assert.equal(again.created, 1);
    assert.equal(JSON.parse(runCli(['source', 'status', ...args]).stdout).lag, 0);
    rmSync(`${profile}.sources.json`);
    const lost = JSON.parse(runCli(['source', 'sync', ...args]).stdout);
    assert.deepEqual([lost.created, lost.unchanged], [0, 2]);
  });
});
