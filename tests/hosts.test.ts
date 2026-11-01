import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { projectNamespace, readTranscript } from '../src/hosts/index.ts';
import { CLI, tempDir } from './helpers.ts';

function cli(args: string[], input?: unknown, cwd?: string) {
  return spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
    encoding: 'utf8',
    cwd,
    input: input === undefined ? undefined : JSON.stringify(input),
    timeout: 30000,
  });
}
function setup(flags: string[] = []) {
  const dir = tempDir(),
    output = join(dir, 'profile with spaces'),
    store = join(dir, 'store with spaces');
  const result = cli([
    'setup',
    '--store',
    store,
    '--output',
    output,
    '--history',
    'none',
    ...flags,
  ]);
  assert.equal(result.status, 0, result.stderr);
  return { dir, output, store, profile: join(output, 'memorykit.profile.json') };
}
function repo(origin: string) {
  const dir = tempDir();
  for (const args of [
    ['init', '-q', dir],
    ['-C', dir, 'remote', 'add', 'origin', origin],
  ]) {
    const result = spawnSync('git', args, { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  }
  return dir;
}
const row = (uuid: string, role: string, text: string) =>
  JSON.stringify({ uuid, type: role, message: { role, content: [{ type: 'text', text }] } }) + '\n';

describe('portable host integration', () => {
  it('creates reviewable fragments, leaves capture off and preserves existing files', () => {
    const f = setup(['--namespace', 'project/acme/alpha']);
    const settings = JSON.parse(
      readFileSync(join(f.output, 'claude.settings.fragment.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(settings.hooks), ['SessionStart']);
    const hook = settings.hooks.SessionStart[0].hooks[0];
    assert.equal(hook.command, process.execPath);
    assert.ok(hook.args.includes(f.profile));
    const event = {
      hook_event_name: 'Stop',
      cwd: f.dir,
      session_id: 's',
      transcript_path: join(f.dir, 'does not exist'),
    };
    const disabled = cli(['hook', '--profile', f.profile, '--host', 'claude-code'], event);
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.equal(disabled.stdout, '');
    const again = cli(['setup', '--store', f.store, '--output', f.output, '--history', 'none']);
    assert.equal(again.status, 1);
    assert.deepEqual(JSON.parse(readFileSync(f.profile, 'utf8')).namespace, 'project/acme/alpha');
    assert.equal(existsSync(join(f.store, 'history.git')), false);
    const freshStore = join(f.dir, 'uncreated store');
    assert.equal(
      cli(['setup', '--store', freshStore, '--output', f.output, '--history', 'none']).status,
      1
    );
    assert.equal(existsSync(freshStore), false);
  });

  it('captures Claude once, recalls in Codex, accepts with a revision, and isolates another project', () => {
    const f = setup(['--capture']);
    const alpha = repo('https://github.com/acme/alpha.git'),
      beta = repo('git@github.com:acme/beta.git');
    const transcript = join(f.dir, 'claude transcript.jsonl');
    writeFileSync(
      transcript,
      row('u1', 'user', 'Use SQLite WAL for concurrent readers.') +
        row('a1', 'assistant', 'I recommend WAL checkpoints.')
    );
    const stop = {
      hook_event_name: 'Stop',
      cwd: alpha,
      session_id: 'claude-session',
      transcript_path: transcript,
    };
    for (let i = 0; i < 2; i++) {
      const result = cli(['hook', '--profile', f.profile, '--host', 'claude-code'], stop);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
    const args = ['context', '--profile', f.profile, '--include-candidates'];
    const found = cli(args, undefined, alpha);
    assert.equal(found.status, 0, found.stderr);
    const items = JSON.parse(found.stdout).items;
    assert.equal(items.length, 2);
    assert.deepEqual(
      new Set(items.map((item: { sourceRole: string }) => item.sourceRole)),
      new Set(['user', 'assistant'])
    );
    assert.equal(
      JSON.parse(cli(['context', '--profile', f.profile], undefined, alpha).stdout).items.length,
      0
    );
    const accept = cli(
      [
        'accept',
        items[0].id,
        '--profile',
        f.profile,
        '--expected-revision',
        String(items[0].revision),
      ],
      undefined,
      alpha
    );
    assert.equal(accept.status, 0, accept.stderr);
    const start = (cwd: string) =>
      cli(['hook', '--profile', f.profile, '--host', 'codex'], {
        hook_event_name: 'SessionStart',
        cwd,
      });
    const recalled = start(alpha);
    assert.equal(recalled.status, 0, recalled.stderr);
    assert.match(JSON.parse(recalled.stdout).hookSpecificOutput.additionalContext, /SQLite|WAL/);
    assert.equal(start(beta).stdout, '');
    // An appended event does not change identities of earlier observations.
    appendFileSync(transcript, row('u2', 'user', 'Use a ten second busy timeout.'));
    assert.equal(cli(['hook', '--profile', f.profile, '--host', 'claude-code'], stop).status, 0);
    const after = JSON.parse(cli(args, undefined, alpha).stdout).items;
    assert.equal(after.length, 3);
    assert.equal(after.find((item: { id: string }) => item.id === items[0].id).status, 'accepted');
  });

  it('parses Codex messages, skips tool/private/context content and reports bounded text', () => {
    const dir = tempDir(),
      transcript = join(dir, 'codex.jsonl');
    const codex = (role: string, content: unknown) =>
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content } }) + '\n';
    writeFileSync(
      transcript,
      codex('user', [{ type: 'input_text', text: 'A preference' }]) +
        codex('assistant', [{ type: 'output_text', text: 'An assistant recap' }]) +
        codex('system', 'secret system text') +
        codex('user', '<private>personal</private>') +
        codex('user', '<memorykit-context>injected</memorykit-context>') +
        'invalid-json\n' +
        codex('user', '😀'.repeat(9000))
    );
    const event = {
      hook_event_name: 'Stop' as const,
      cwd: dir,
      session_id: 'codex',
      transcript_path: transcript,
    };
    const result = readTranscript('codex', event, 'project/acme/alpha');
    assert.equal(result.input!.observations.length, 3);
    assert.equal(result.skipped, 3);
    assert.equal(result.truncated, true);
    assert.doesNotMatch(result.input!.observations[2]!.content, /\uFFFD/);
    const ids = result.input!.observations.map((item) => item.id);
    appendFileSync(transcript, codex('user', 'Another preference'));
    assert.deepEqual(
      readTranscript('codex', event, 'project/acme/alpha')
        .input!.observations.slice(0, 3)
        .map((item) => item.id),
      ids
    );
  });

  it('requires an explicit namespace without a supported remote and fails hooks without blocking the host', () => {
    assert.throws(() => projectNamespace(tempDir()), /explicit namespace/);
    assert.throws(() => projectNamespace(repo('file:///tmp/owner/repo.git')), /explicit namespace/);
    assert.equal(projectNamespace(repo('ssh://git@github.com/Acme/Repo.git')), 'project/acme/repo');
    const f = setup(['--namespace', 'project/acme/alpha', '--capture']);
    mkdirSync(join(f.dir, 'unrelated'));
    const result = cli(['hook', '--profile', f.profile, '--host', 'codex'], {
      hook_event_name: 'Stop',
      cwd: f.dir,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ValidationFailed/);
  });

  it('imports a mapped export outside Git, then retries without duplication', () => {
    const f = setup();
    const input = join(f.dir, 'export.json'),
      mapping = join(f.dir, 'mapping.json');
    writeFileSync(
      input,
      JSON.stringify({
        observations: [{ id: 1, project: 'alpha', text: 'An imported observation' }],
      })
    );
    writeFileSync(mapping, JSON.stringify({ alpha: 'project/acme/alpha' }));
    const args = [
      'import-claude-mem',
      '--profile',
      f.profile,
      '--input',
      input,
      '--mapping',
      mapping,
      '--source-id',
      'laptop',
    ];
    const dry = cli([...args, '--dry-run'], undefined, f.dir);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);
    for (let i = 0; i < 2; i++) {
      const result = cli(args, undefined, f.dir);
      assert.equal(result.status, 0, result.stderr);
    }
    const result = cli([
      'context',
      '--profile',
      f.profile,
      '--namespace',
      'project/acme/alpha',
      '--include-candidates',
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).items.length, 1);
  });
});
