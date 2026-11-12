import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EMBEDDED_PRINCIPAL } from '../src/access/index.ts';
import { initStore, openStore } from '../src/sdk/index.ts';
import type { MemoryClient } from '../src/service/index.ts';
import { browse } from '../src/workflow/browse.ts';
import {
  chunkText,
  planGitSource,
  syncGitSource,
  validateGitSource,
  type GitSourceConfig,
} from '../src/workflow/git-source.ts';
import { context } from '../src/workflow/index.ts';
import { runCli, tempDir } from './helpers.ts';

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
    { cwd, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function write(root: string, path: string, content: string | Buffer): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function transcript(bytes: number): string {
  let text = '# Transcript\n\nIntro line.\n\n';
  for (let turn = 1; text.length < bytes; turn++) {
    text += `## Turn ${turn}\n\n${`Discussion of caching strategy number ${turn}. `.repeat(12)}\n\n`;
  }
  return text;
}

const PRIVATE_KEY = [
  '-----BEGIN ',
  'RSA PRIVATE KEY',
  '-----\nAAAA\n-----END RSA PRIVATE KEY-----',
];

function fixtureRepo(): { root: string; marker: string } {
  const root = tempDir();
  const marker = join(tempDir(), 'driver-ran');
  const script = join(tempDir(), 'driver.mjs');
  writeFileSync(
    script,
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'ran');\n`
  );
  git(root, 'init', '-q', '-b', 'main');
  write(
    root,
    'Notes/alpha/decision.md',
    '---\ntitle: Use WAL\ndate: 2026-01-02\ntype: decision\ntags: [sqlite, wal]\nsecretish: ignored\n---\n# Use WAL\n\nUse SQLite WAL for concurrent readers.\n'
  );
  write(root, 'Notes/beta/plain.txt', 'Plain text note about gardening.\n');
  write(root, 'Notes/alpha/transcript.md', transcript(570 * 1024));
  write(root, 'Notes/huge.txt', Buffer.alloc(5 * 1024 * 1024, 'a'));
  write(root, 'Notes/leaked.md', `Notes\n${PRIVATE_KEY.join('')}\n`);
  write(root, 'Notes/image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  write(root, 'Notes/broken.md', '---\ntitle: [unterminated\n---\nbody\n');
  write(root, 'Journal/day.md', 'journal-private-text that must never be imported\n');
  write(root, 'Notes/.env', 'TOKEN=not-imported\n');
  write(root, 'Other/loose.md', 'Unmapped note.\n');
  write(root, '.gitattributes', '*.md diff=probe filter=probe\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture');
  git(root, 'config', 'diff.probe.textconv', `node "${script.replace(/\\/g, '/')}"`);
  git(root, 'config', 'filter.probe.clean', `node "${script.replace(/\\/g, '/')}"`);
  git(root, 'config', 'filter.probe.smudge', `node "${script.replace(/\\/g, '/')}"`);
  return { root, marker };
}

function config(root: string, extra: Partial<GitSourceConfig> = {}): GitSourceConfig {
  return {
    id: 'notes',
    repository: root,
    ref: 'main',
    include: ['Notes/**', 'Other/**', 'Journal/**'],
    exclude: ['Journal/**'],
    namespace: {
      by: 'first-segment',
      map: { Notes: 'project/acme/notes' },
    },
    ...extra,
  };
}

async function openClient(): Promise<MemoryClient> {
  const store = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(store);
  const client = await openStore(store, EMBEDDED_PRINCIPAL);
  after(() => client.close());
  return client;
}

function snapshot(dir: string): string {
  const hash = createHash('sha256');
  const walk = (path: string): void => {
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      hash.update(full.slice(dir.length));
      if (statSync(full).isDirectory()) walk(full);
      else hash.update(readFileSync(full));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

async function all(client: MemoryClient, namespace: string) {
  const items = [];
  let cursor: string | undefined;
  do {
    const page = await client.search({
      namespaces: [namespace],
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return items;
}

const repo = fixtureRepo();

describe('git source plan and sync (S27.1)', () => {
  it('plans without writes, then sync creates exactly the plan', async () => {
    const client = await openClient();
    const before = await all(client, 'project/acme/notes');
    const plan = planGitSource(config(repo.root));
    assert.equal(plan.commit, git(repo.root, 'rev-parse', 'main'));
    assert.deepEqual(await all(client, 'project/acme/notes'), before);
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.path, s.reason]));
    assert.equal(reasons['Notes/huge.txt'], 'size');
    assert.equal(reasons['Notes/leaked.md'], 'secret');
    assert.equal(reasons['Notes/image.png'], 'type');
    assert.equal(reasons['Notes/broken.md'], 'front-matter');
    assert.equal(reasons['Other/loose.md'], 'unmapped');
    assert.ok(plan.counts.chunkedFiles >= 1);

    const result = await syncGitSource(client, config(repo.root));
    assert.equal(result.completeness, 'complete');
    assert.equal(result.created, plan.records.length);
    const records = await all(client, 'project/acme/notes');
    assert.deepEqual(records.map((r) => r.key).sort(), plan.records.map((r) => r.input.key).sort());
    const wal = records.find((r) => r.key === 'git:notes:Notes/alpha/decision.md')!;
    assert.equal(wal.kind, 'document');
    assert.equal(wal.metadata.status, 'candidate');
    const source = wal.metadata.source as Record<string, string>;
    assert.equal(source.kind, 'git');
    assert.equal(source.commit, plan.commit);
    assert.equal(source.path, 'Notes/alpha/decision.md');
    assert.match(source.blob!, /^[0-9a-f]{40,64}$/);
    assert.deepEqual((wal.metadata.frontmatter as Record<string, unknown>).tags, ['sqlite', 'wal']);
    assert.equal((wal.metadata.frontmatter as Record<string, unknown>).secretish, undefined);
    assert.equal(wal.provenance.origin?.kind, 'git-source');
    assert.equal(wal.provenance.origin?.version, plan.commit);
    assert.equal(
      wal.provenance.evidence?.[0]?.ref,
      `git:notes@${plan.commit}:Notes/alpha/decision.md`
    );
    assert.match(wal.provenance.evidence?.[0]?.note ?? '', new RegExp(source.blob!));
  });

  it('maps type through the kinds table', () => {
    const plan = planGitSource(config(repo.root, { kinds: { decision: 'decision' } }));
    const rec = plan.records.find((r) => r.path === 'Notes/alpha/decision.md')!;
    assert.equal(rec.input.kind, 'decision');
  });

  it('validates source configuration', () => {
    assert.throws(() => validateGitSource({ ...config(repo.root), ref: '' }));
    assert.throws(() => validateGitSource({ ...config(repo.root), ref: '--upload-pack=x' }));
    assert.throws(() => validateGitSource({ ...config(repo.root), include: [] }));
    assert.throws(() => validateGitSource({ ...config(repo.root), repository: 'relative' }));
    assert.throws(() => validateGitSource({ ...config(repo.root), extra: 1 }));
  });
});

describe('git source replay (S27.2)', () => {
  it('a repeat sync at the same commit writes nothing', async () => {
    const client = await openClient();
    const first = await syncGitSource(client, config(repo.root));
    const records = await all(client, 'project/acme/notes');
    const second = await syncGitSource(client, config(repo.root));
    assert.equal(second.created, 0);
    assert.equal(second.unchanged, first.created);
    const again = await all(client, 'project/acme/notes');
    assert.equal(again.length, records.length);
    assert.deepEqual(
      again.map((r) => [r.id, r.revision]).sort(),
      records.map((r) => [r.id, r.revision]).sort()
    );
  });

  it('resumes after a crash mid-import with no duplicates', async () => {
    const client = await openClient();
    let calls = 0;
    const crashing = Object.create(client) as MemoryClient;
    crashing.create = async (input, opts) => {
      if (++calls > 2) throw new Error('injected crash');
      return client.create(input, opts);
    };
    const partial = await syncGitSource(crashing, config(repo.root));
    assert.equal(partial.completeness, 'partial');
    assert.equal(partial.created, 2);
    const resumed = await syncGitSource(client, config(repo.root));
    assert.equal(resumed.completeness, 'complete');
    assert.equal(resumed.unchanged, 2);
    const records = await all(client, 'project/acme/notes');
    const plan = planGitSource(config(repo.root));
    assert.equal(records.length, plan.records.length);
    assert.ok(records.every((r) => r.revision === 1));
  });
});

describe('git source chunking (S27.3)', () => {
  it('splits a 570 KB transcript into ordered sections within the limit', () => {
    const text = transcript(570 * 1024);
    const chunks = chunkText(text, 32768);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => Buffer.byteLength(c) <= 32768));
    assert.equal(chunks.join(''), text);
    const plan = planGitSource(config(repo.root));
    const records = plan.records.filter((r) => r.path === 'Notes/alpha/transcript.md');
    assert.equal(records.map((r) => r.input.content).join(''), text);
    assert.match(records[0]!.input.key!, /#001-/);
    assert.ok(records.every((r) => r.bytes <= 32768));
  });

  it('splits an unbroken paragraph on character boundaries', () => {
    const text = '日本語のテキスト。'.repeat(5000);
    const chunks = chunkText(text, 4096);
    assert.ok(chunks.every((c) => Buffer.byteLength(c) <= 4096));
    assert.equal(chunks.join(''), text);
  });

  it('skips a 5 MiB file and reports it', () => {
    const plan = planGitSource(config(repo.root));
    const skip = plan.skipped.find((s) => s.path === 'Notes/huge.txt');
    assert.equal(skip?.reason, 'size');
    assert.equal(skip?.bytes, 5 * 1024 * 1024);
  });
});

describe('git source reads only committed objects (S27.4)', () => {
  it('ignores working-tree edits and leaves the repository untouched', async () => {
    write(repo.root, 'Notes/alpha/decision.md', 'UNCOMMITTED-EDIT\n');
    write(repo.root, 'Notes/untracked.md', 'UNTRACKED-FILE\n');
    const before = snapshot(join(repo.root, '.git'));
    const client = await openClient();
    await syncGitSource(client, config(repo.root));
    const records = await all(client, 'project/acme/notes');
    assert.ok(records.every((r) => !r.content.includes('UNCOMMITTED-EDIT')));
    assert.ok(records.every((r) => !r.content.includes('UNTRACKED-FILE')));
    assert.equal(snapshot(join(repo.root, '.git')), before);
    assert.equal(existsSync(repo.marker), false, 'textconv or filter driver ran');
  });
});

describe('git source exclusions and secrets (S27.5)', () => {
  it('never reveals excluded paths beyond a count', async () => {
    const client = await openClient();
    const plan = planGitSource(config(repo.root));
    const result = await syncGitSource(client, config(repo.root));
    const report = JSON.stringify({ plan, result });
    assert.ok(!report.includes('Journal/'));
    assert.ok(!report.includes('journal-private-text'));
    assert.ok(!report.includes('.env'));
    assert.ok(plan.counts.excluded >= 2);
    const stored = JSON.stringify(await all(client, 'project/acme/notes'));
    assert.ok(!stored.includes('journal-private-text'));
    assert.ok(!stored.includes('not-imported'));
  });

  it('skips a file with a private-key block by rule, without storing it', async () => {
    const client = await openClient();
    const plan = planGitSource(config(repo.root));
    const skip = plan.skipped.find((s) => s.path === 'Notes/leaked.md');
    assert.deepEqual(skip, { path: 'Notes/leaked.md', reason: 'secret', rule: 'private-key' });
    await syncGitSource(client, config(repo.root));
    const stored = JSON.stringify(await all(client, 'project/acme/notes'));
    assert.ok(!stored.includes('PRIVATE KEY'));
  });
});

describe('git source records are retrievable only in their namespace (S27.6)', () => {
  it('finds imports through retrieve, browse and context', async () => {
    const client = await openClient();
    await syncGitSource(client, config(repo.root, { kinds: { decision: 'decision' } }));
    const found = await client.retrieve({ namespaces: ['project/acme/notes'], text: 'concurrent' });
    assert.ok(found.items.some((i) => i.key === 'git:notes:Notes/alpha/decision.md'));
    const elsewhere = await client.retrieve({
      namespaces: ['project/acme/other'],
      text: 'concurrent',
    });
    assert.equal(elsewhere.items.length, 0);
    const browsed = await browse(client, {
      namespace: 'project/acme/notes',
      includeCandidates: true,
      text: 'WAL',
    });
    assert.ok(browsed.items.some((i) => i.key === 'git:notes:Notes/alpha/decision.md'));
    const other = await browse(client, {
      namespace: 'project/acme/other',
      includeCandidates: true,
    });
    assert.equal(other.items.length, 0);
    const ctx = await context(client, {
      namespace: 'project/acme/notes',
      text: 'concurrent readers',
      includeCandidates: true,
    });
    assert.ok(ctx.items.some((i) => i.content.includes('concurrent readers')));
    const none = await context(client, {
      namespace: 'project/acme/other',
      text: 'concurrent readers',
      includeCandidates: true,
    });
    assert.equal(none.items.length, 0);
  });

  it('keeps candidates out of default context and includes accepted ones', async () => {
    const client = await openClient();
    await syncGitSource(client, config(repo.root, { status: 'accepted' }));
    const ctx = await context(client, {
      namespace: 'project/acme/notes',
      text: 'concurrent readers',
    });
    assert.ok(ctx.items.length > 0);
    const candidate = await openClient();
    await syncGitSource(candidate, config(repo.root));
    const hidden = await context(candidate, {
      namespace: 'project/acme/notes',
      text: 'concurrent readers',
    });
    assert.equal(hidden.items.length, 0);
  });
});

describe('memorykit source CLI', () => {
  it('plans and syncs a configured source from a profile', () => {
    const dir = tempDir();
    const store = join(dir, 'store');
    const init = runCli(['init', store]);
    assert.equal(init.status, 0, init.stderr);
    const profile = join(dir, 'profile.json');
    writeFileSync(
      profile,
      JSON.stringify({
        version: 1,
        store,
        history: 'none',
        namespace: 'project/acme/notes',
        sources: [config(repo.root)],
      })
    );
    const plan = runCli(['source', 'plan', '--profile', profile, '--source', 'notes']);
    assert.equal(plan.status, 0, plan.stderr);
    const planned = JSON.parse(plan.stdout) as { dryRun: boolean; counts: { records: number } };
    assert.ok(planned.counts.records > 0);
    assert.ok(!plan.stdout.includes('journal-private-text'));
    const sync = runCli(['source', 'sync', '--profile', profile, '--source', 'notes']);
    assert.equal(sync.status, 0, sync.stderr);
    const synced = JSON.parse(sync.stdout) as { created: number; completeness: string };
    assert.equal(synced.created, planned.counts.records);
    const again = runCli(['source', 'sync', '--profile', profile, '--source', 'notes']);
    assert.equal(JSON.parse(again.stdout).created, 0);
    const unknown = runCli(['source', 'sync', '--profile', profile, '--source', 'missing']);
    assert.equal(unknown.status, 1);
  });
});
