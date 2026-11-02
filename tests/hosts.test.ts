import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { projectNamespace, promptQuery, readTranscript } from '../src/hosts/index.ts';
import { openStore } from '../src/sdk/index.ts';
import { capture, planCapture } from '../src/workflow/index.ts';
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
  it('uses a configured selector for both prompt hooks and fails closed on invalid output', async () => {
    const f = setup(['--namespace', 'project/acme/alpha']);
    const client = await openStore({ path: f.store, history: { provider: 'none' } });
    try {
      await client.create({
        namespace: 'project/acme/alpha',
        kind: 'note',
        content: 'The bicycle is in the shed.',
        metadata: { status: 'accepted' },
      });
      await client.create({
        namespace: 'private/other',
        kind: 'note',
        content: 'Private bicycle location.',
        metadata: { status: 'accepted' },
      });
    } finally {
      await client.close();
    }
    const provider = join(f.dir, 'selector with spaces.mjs');
    writeFileSync(
      provider,
      `let raw=''; for await(const chunk of process.stdin) raw+=chunk;
const r=JSON.parse(raw); if(r.task!=='select'||r.query!=='Where is my cycling equipment?'||r.passages.length!==1)process.exit(1);
const p=r.passages[0]; console.log(JSON.stringify({selections:[{id:p.id,revision:p.revision,quote:p.content}]}));`
    );
    const profile = JSON.parse(readFileSync(f.profile, 'utf8'));
    profile.recall = {
      id: 'test-selector',
      command: { command: process.execPath, args: [provider] },
    };
    writeFileSync(f.profile, JSON.stringify(profile));
    for (const host of ['claude-code', 'codex']) {
      const result = cli(['hook', '--profile', f.profile, '--host', host], {
        hook_event_name: 'UserPromptSubmit',
        cwd: f.dir,
        prompt: 'Where is my cycling equipment?',
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(
        JSON.parse(result.stdout).hookSpecificOutput.additionalContext,
        /bicycle is in the shed/
      );
      assert.doesNotMatch(result.stdout, /Private bicycle/);
    }
    writeFileSync(
      provider,
      'console.log(JSON.stringify({selections:[{id:"outside",revision:1,quote:"fabrication"}]}));'
    );
    const invalid = cli(['hook', '--profile', f.profile, '--host', 'codex'], {
      hook_event_name: 'UserPromptSubmit',
      cwd: f.dir,
      prompt: 'Where is my cycling equipment?',
    });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, '');
    assert.match(invalid.stderr, /ValidationFailed/);
  });
  it('creates reviewable fragments, leaves capture off and preserves existing files', () => {
    const f = setup(['--namespace', 'project/acme/alpha']);
    const settings = JSON.parse(
      readFileSync(join(f.output, 'claude.settings.fragment.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(settings.hooks), ['UserPromptSubmit']);
    const hook = settings.hooks.UserPromptSubmit[0].hooks[0];
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
        hook_event_name: 'UserPromptSubmit',
        prompt: 'SQLite WAL',
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

  it('retrieves the submitted task across hosts and restarts, respecting scopes and corrections', async () => {
    const f = setup();
    const alpha = repo('https://github.com/acme/alpha.git');
    const beta = repo('https://github.com/acme/beta.git');
    const client = await openStore({ path: f.store, history: { provider: 'none' } });
    let currentId: string;
    try {
      const add = async (namespace: string, content: string, status = 'accepted') =>
        (await client.create({ namespace, kind: 'note', content, metadata: { status } })).memory;
      const old = await add('project/acme/alpha', 'Quartz deployment target is OLD-RED.');
      const corrected = await client.supersede({
        id: old.id,
        expectedRevision: 1,
        replacement: {
          kind: 'note',
          content: 'Quartz deployment target is NEW-BLUE.',
          metadata: { status: 'accepted' },
        },
      });
      currentId = corrected.memory.id;
      await add('project/acme/alpha', 'Lunch menu is soup.');
      await add('project/acme/alpha', 'Quartz target is UNREVIEWED.', 'candidate');
      await add('project/acme/beta', 'Quartz deployment target is OTHER-PROJECT.');
      await add('team/engineering', 'Quartz deployment checks require SHARED-CHECK.');
      await add('personal/private', 'Quartz private value is PRIVATE-SECRET.');
    } finally {
      await client.close();
    }
    const p = JSON.parse(readFileSync(f.profile, 'utf8'));
    p.sharedNamespaces = ['team/engineering'];
    writeFileSync(f.profile, JSON.stringify(p));
    for (const host of ['claude-code', 'codex']) {
      const run = (prompt: unknown, cwd = alpha, extra: object = {}) =>
        cli(['hook', '--profile', f.profile, '--host', host], {
          hook_event_name: 'UserPromptSubmit',
          cwd,
          prompt,
          transcript_path: null,
          ...extra,
        });
      // Each invocation opens the durable store in a fresh process.
      for (let attempt = 0; attempt < 2; attempt++) {
        const found = run('Quartz deployment');
        assert.equal(found.status, 0, found.stderr);
        const output = JSON.parse(found.stdout).hookSpecificOutput;
        assert.equal(output.hookEventName, 'UserPromptSubmit');
        assert.match(output.additionalContext, /NEW-BLUE/);
        assert.ok(output.additionalContext.includes(currentId));
        assert.match(output.additionalContext, /SHARED-CHECK/);
        assert.doesNotMatch(
          output.additionalContext,
          /OLD-RED|OTHER-PROJECT|PRIVATE-SECRET|UNREVIEWED|soup/
        );
      }
      assert.equal(run('unmatched-zebracorn').stdout, '');
      assert.equal(run('   ').stdout, '');
      assert.equal(run('!!! 😀').stdout, '');
      const clipped = run('Quartz deployment ' + 'x'.repeat(2000));
      assert.equal(clipped.status, 0, clipped.stderr);
      assert.match(clipped.stderr, /first 1024/);
      const other = run('Quartz', beta);
      assert.match(other.stdout, /OTHER-PROJECT/);
      assert.doesNotMatch(other.stdout, /NEW-BLUE|PRIVATE-SECRET/);
      for (const prompt of [undefined, 42, {}]) {
        const invalid = run(prompt);
        assert.equal(invalid.status, 1);
        assert.equal(invalid.stdout, '');
      }
      const tooLarge = run('x'.repeat(65537));
      assert.equal(tooLarge.status, 1);
      assert.equal(tooLarge.stdout, '');
      const start = cli(['hook', '--profile', f.profile, '--host', host], {
        hook_event_name: 'SessionStart',
        cwd: alpha,
      });
      assert.equal(start.stdout, '');
      assert.equal(start.status, 0);
    }
  });

  it('bounds normalized prompt queries without splitting Unicode or selecting recency', () => {
    assert.deepEqual(promptQuery('\nQuartz\t deployment\r\n'), {
      text: 'Quartz deployment',
      truncated: false,
    });
    assert.deepEqual(promptQuery('!!!'), { text: undefined, truncated: false });
    const result = promptQuery('x'.repeat(1023) + '😀 tail');
    assert.equal(result.text!.length, 1023);
    assert.equal(result.truncated, true);
    assert.doesNotMatch(result.text!, /\p{Cs}/u);
  });

  it('makes startup context explicit and honors the context kill switch before opening a store', async () => {
    const f = setup(['--namespace', 'project/acme/alpha', '--startup-context']);
    const settings = JSON.parse(readFileSync(join(f.output, 'codex.hooks.fragment.json'), 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks), ['UserPromptSubmit', 'SessionStart']);
    const client = await openStore({ path: f.store, history: { provider: 'none' } });
    try {
      await client.create({
        namespace: 'project/acme/alpha',
        kind: 'note',
        content: 'Explicit startup memory',
        metadata: { status: 'accepted' },
      });
    } finally {
      await client.close();
    }
    const start = cli(['hook', '--profile', f.profile, '--host', 'codex'], {
      cwd: f.dir,
      hook_event_name: 'SessionStart',
    });
    assert.equal(start.status, 0, start.stderr);
    assert.match(
      JSON.parse(start.stdout).hookSpecificOutput.additionalContext,
      /Explicit startup memory/
    );
    const p = JSON.parse(readFileSync(f.profile, 'utf8'));
    p.context = false;
    p.store = join(f.dir, 'missing-store');
    writeFileSync(f.profile, JSON.stringify(p));
    for (const event of [
      { hook_event_name: 'UserPromptSubmit', prompt: 'Quartz' },
      { hook_event_name: 'SessionStart' },
    ]) {
      const result = cli(['hook', '--profile', f.profile, '--host', 'codex'], {
        cwd: f.dir,
        ...event,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
    }
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

  it('keeps Codex capture identities stable across transcript rewrites without offset collisions', () => {
    const dir = tempDir(),
      transcript = join(dir, 'resumed.jsonl');
    const row = (content: string, timestamp = '2026-11-01T10:00:00Z', role = 'user') =>
      JSON.stringify({
        timestamp,
        type: 'response_item',
        payload: { type: 'message', role, content },
      }) + '\n';
    const event = {
      hook_event_name: 'Stop' as const,
      cwd: dir,
      session_id: 'resumed',
      transcript_path: transcript,
    };
    const read = () => readTranscript('codex', event, 'project/acme/alpha').input!.observations;
    writeFileSync(transcript, row('original') + row('retained'));
    const initial = read();
    // New text occupies byte zero and an existing observation moves after compaction.
    writeFileSync(transcript, row('new') + row('retained'));
    const resumed = read();
    assert.notEqual(resumed[0]!.id, initial[0]!.id);
    assert.equal(resumed[1]!.id, initial[1]!.id);
    writeFileSync(
      transcript,
      row('retained') +
        row('retained') +
        row('retained', undefined, 'assistant') +
        row('retained', '2026-11-01T10:01:00Z')
    );
    const repeated = read();
    assert.equal(repeated[0]!.id, initial[1]!.id);
    assert.equal(new Set(repeated.map((item) => item.id)).size, 4);
  });

  it('replays Codex capture after a resumed transcript moves to another file', async () => {
    const f = setup(['--namespace', 'project/acme/alpha']);
    const transcript = join(f.dir, 'initial.jsonl');
    const relocated = join(f.dir, 'resumed.jsonl');
    const text =
      JSON.stringify({
        timestamp: '2026-11-01T10:00:00Z',
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: 'Keep this source statement.' },
      }) + '\n';
    writeFileSync(transcript, text);
    writeFileSync(relocated, JSON.stringify({ type: 'session_meta' }) + '\n' + text);
    const event = { hook_event_name: 'Stop' as const, cwd: f.dir, session_id: 'same-session' };
    const initial = readTranscript(
      'codex',
      { ...event, transcript_path: transcript },
      'project/acme/alpha'
    ).input!;
    const resumed = readTranscript(
      'codex',
      { ...event, transcript_path: relocated },
      'project/acme/alpha'
    ).input!;
    assert.deepEqual(planCapture(resumed), planCapture(initial));
    assert.equal(resumed.source.ref, 'codex:session:same-session');
    const client = await openStore({ path: f.store, history: { provider: 'none' } });
    try {
      const first = await capture(client, initial);
      assert.equal(first.completeness, 'complete');
      const id = first.items[0]!.outcome.memory.id;
      await client.update({ id, expectedRevision: 1, metadata: { status: 'accepted' } });
      const replay = await capture(client, resumed);
      assert.deepEqual(replay.failures, []);
      assert.equal(replay.items[0]!.outcome.memory.id, id);
      assert.equal((await client.get(id)).metadata.status, 'accepted');
      assert.equal((await client.search({ namespaces: ['project/acme/alpha'] })).items.length, 1);
    } finally {
      await client.close();
    }
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
