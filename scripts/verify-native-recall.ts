// Opt-in, credentialed acceptance test. Uses an installed Claude Code or Codex executable,
// an installed MemoryKit CLI, synthetic data, disabled tools/MCP and isolated settings.
// Never part of npm test: it makes real model calls using the host's existing login.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/sdk/index.ts';
import { context } from '../src/workflow/index.ts';
import { CommandRecallSelector } from '../src/providers-command/index.ts';
import { recallFingerprint } from '../src/workflow/readiness.ts';

const { values } = parseArgs({
  options: {
    cli: { type: 'string' },
    claude: { type: 'string', default: 'claude' },
    codex: { type: 'string', default: 'codex' },
    host: { type: 'string', default: 'claude-code' },
    selector: { type: 'string' },
    report: { type: 'string' },
    storage: { type: 'string', default: 'sqlite' },
    peer: { type: 'string' },
  },
});
assert.ok(values.cli, 'Supply --cli /absolute/path/to/installed/dist/cli/main.js');
const cli = resolve(values.cli);
assert.ok(['claude-code', 'codex'].includes(values.host!));
const isCodex = values.host === 'codex';
const executable = isCodex ? values.codex! : values.claude!;
assert.ok(existsSync(cli), 'Installed CLI does not exist');
const work = mkdtempSync(join(tmpdir(), 'memorykit-native-'));
const checks: { name: string; passed: boolean; contextBytes: number }[] = [];
let version = 'unavailable';
let configurationFingerprint: string | null = null;
let activeCheck = 'native acceptance setup';
const writeReport = (report: unknown) => {
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.report) {
    const destination = resolve(values.report);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, json);
  }
  process.stdout.write(json);
};
const env = { ...process.env };
const run = (command: string, args: string[], cwd = work, input?: string) => {
  const result = spawnSync(command, args, {
    cwd,
    env,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 180000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    `${command} failed (${result.error?.message ?? result.status}): ${result.stderr}`
  );
  return result.stdout;
};
try {
  version = run(executable, ['--version']).trim();
  const store = join(work, 'store');
  let config = join(work, 'config with spaces');
  run(process.execPath, [
    cli,
    'setup',
    '--store',
    store,
    '--storage',
    values.storage!,
    '--output',
    config,
    '--history',
    'none',
  ]);
  const profilePath = join(config, 'memorykit.profile.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.capture = true;
  profile.sharedNamespaces = ['team/native'];
  if (values.selector) profile.recall = JSON.parse(readFileSync(resolve(values.selector), 'utf8'));
  configurationFingerprint = profile.recall ? recallFingerprint(profile.recall) : null;
  writeFileSync(profilePath, JSON.stringify(profile));
  const upgraded = join(work, 'upgraded config with spaces');
  run(process.execPath, [cli, 'upgrade', '--profile', profilePath, '--output', upgraded]);
  config = upgraded;
  const alpha = join(work, 'alpha'),
    beta = join(work, 'beta');
  for (const project of [alpha, beta]) {
    mkdirSync(project);
    run('git', ['init', '-q'], project);
    run(
      'git',
      [
        'remote',
        'add',
        'origin',
        `https://github.com/native/${project === alpha ? 'alpha' : 'beta'}.git`,
      ],
      project
    );
  }
  const markers = {
    initial: 'Q-' + randomUUID(),
    corrected: 'Q-' + randomUUID(),
    other: 'Q-' + randomUUID(),
    shared: 'H-' + randomUUID(),
    private: 'Q-' + randomUUID(),
  };
  const connect = () => openStore({ path: store, history: { provider: 'none' } });
  let client = await connect();
  let original;
  try {
    const add = async (namespace: string, content: string) =>
      (await client.create({ namespace, kind: 'note', content, metadata: { status: 'accepted' } }))
        .memory;
    original = await add(
      'project/native/alpha',
      `Quartz deployment passcode is ${markers.initial}.`
    );
    await add('project/native/beta', `Quartz deployment passcode is ${markers.other}.`);
    await add('team/native', `Helix team passcode is ${markers.shared}.`);
    await add('personal/private', `Quartz deployment passcode is ${markers.private}.`);
    await add('project/native/alpha', 'Lunch menu is soup.');
  } finally {
    await client.close();
  }

  // Wrap the generated executable/args unchanged. Record actual host invocations and
  // forward the exact CLI output, allowing assertions independent of model compliance.
  const settings = JSON.parse(
    readFileSync(
      join(config, isCodex ? 'codex.hooks.fragment.json' : 'claude.settings.fragment.json'),
      'utf8'
    )
  );
  const generated = settings.hooks.UserPromptSubmit[0].hooks[0];
  const originalSettings = structuredClone(settings);
  const originalGenerated = structuredClone(generated);
  const log = join(work, 'hook.json');
  const wrapper = join(work, 'observe-hook.cjs');
  writeFileSync(
    wrapper,
    `
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
const startedAt=Date.now();
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({input:JSON.parse(input), started:true, startedAt}));
const result = spawnSync(${JSON.stringify(generated.command)}, ${JSON.stringify(generated.args ?? [])},
  {input, encoding:'utf8', windowsHide:true, timeout:150000, shell:${isCodex ? JSON.stringify(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh') : 'false'}});
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({input:JSON.parse(input), status:result.status, elapsedMs:Date.now()-startedAt, output:result.stdout, stderr:result.stderr, error:result.error?.message}));
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === 0 ? 0 : 1);
`
  );
  generated.command = isCodex
    ? 'node ' + JSON.stringify(wrapper.replaceAll('\\', '/'))
    : process.execPath;
  if (!isCodex) generated.args = [wrapper];
  const captureLog = join(work, 'capture-hooks.jsonl');
  for (const event of ['Stop', 'PreCompact']) {
    const hook = settings.hooks[event][0].hooks[0];
    const observer = join(work, `observe-${event}.cjs`);
    writeFileSync(
      observer,
      `
const fs=require('node:fs'); const {spawnSync}=require('node:child_process');
const input=fs.readFileSync(0,'utf8');
const r=spawnSync(${JSON.stringify(hook.command)},${JSON.stringify(hook.args ?? [])},
 {input,encoding:'utf8',windowsHide:true,timeout:150000,shell:${isCodex ? JSON.stringify(process.platform === 'win32' ? 'powershell.exe' : '/bin/sh') : 'false'}});
fs.appendFileSync(${JSON.stringify(captureLog)},JSON.stringify({input:JSON.parse(input),status:r.status,stderr:r.stderr})+'\\n');
process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');process.exit(r.status===0?0:1);
`
    );
    hook.command = isCodex
      ? 'node ' + JSON.stringify(observer.replaceAll('\\', '/'))
      : process.execPath;
    if (!isCodex) hook.args = [observer];
  }
  const codexHome = join(work, 'codex-home');
  const instructions =
    'Answer the question using supplied memory only. Reply with the passcode only. If memory has no answer, reply MISSING. Do not use tools.';
  if (isCodex) {
    mkdirSync(codexHome);
    // Existing login only; never read/copy global config, hooks, rules or sessions.
    copyFileSync(
      join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
      join(codexHome, 'auth.json')
    );
    env.CODEX_HOME = codexHome;
    writeFileSync(join(codexHome, 'instructions.txt'), instructions);
    writeFileSync(
      join(codexHome, 'config.toml'),
      `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nmodel_reasoning_effort = "low"\nmodel_instructions_file = ${JSON.stringify(join(codexHome, 'instructions.txt').replaceAll('\\', '/'))}\n[features]\nshell_tool = false\napply_patch_freeform = false\n`
    );
  }
  const settingsPath = isCodex ? join(codexHome, 'hooks.json') : join(work, 'settings.json');
  const managedProfile = join(config, 'memorykit.profile.json');
  const managedFlags = [
    '--profile',
    managedProfile,
    '--host',
    values.host!,
    '--settings',
    settingsPath,
  ];
  run(process.execPath, [cli, 'install', ...managedFlags]);
  const diagnostic = JSON.parse(
    run(process.execPath, [cli, 'doctor', ...managedFlags, '--probe'], alpha)
  );
  assert.equal(diagnostic.installation.executionProbe, true);
  checks.push({ name: 'managed installation command probe', passed: true, contextBytes: 0 });
  writeFileSync(settingsPath, JSON.stringify(settings));
  let persistent = false;
  const check = (
    name: string,
    prompt: string,
    cwd: string,
    expected: string,
    forbidden: string[],
    observe = true,
    assertAnswer = true
  ) => {
    activeCheck = name;
    if (existsSync(log)) rmSync(log);
    const output = run(
      executable,
      isCodex
        ? [
            'exec',
            ...(persistent ? [] : ['--ephemeral']),
            '--ignore-rules',
            '--dangerously-bypass-hook-trust',
            '--json',
            '--output-last-message',
            join(work, 'answer.txt'),
            prompt,
          ]
        : [
            '-p',
            prompt,
            '--output-format',
            'json',
            '--setting-sources',
            '',
            '--settings',
            settingsPath,
            '--strict-mcp-config',
            '--mcp-config',
            '{"mcpServers":{}}',
            '--tools',
            '',
            ...(persistent ? [] : ['--no-session-persistence']),
            '--append-system-prompt',
            instructions,
          ],
      cwd
    );
    if (!observe) {
      const answer = readFileSync(join(work, 'answer.txt'), 'utf8');
      assert.ok(
        answer.includes(expected),
        `${name}: original generated hook did not deliver memory`
      );
      for (const value of forbidden) assert.ok(!answer.includes(value));
      checks.push({ name, passed: true, contextBytes: 0 });
      process.stderr.write(`PASS ${name}\n`);
      return;
    }
    assert.ok(
      existsSync(log),
      `${name}: native host did not invoke the hook: ${output.slice(-4000)}`
    );
    const invocation = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(
      invocation.status,
      0,
      `${name}: hook failed${invocation.started ? ` or was interrupted after starting (${Date.now() - invocation.startedAt} ms ago)` : ` after ${invocation.elapsedMs} ms`}: ${String(invocation.error ?? invocation.stderr ?? output.slice(-4000)).slice(0, 4000)}`
    );
    assert.equal(invocation.input.hook_event_name, 'UserPromptSubmit');
    assert.equal(invocation.input.prompt, prompt);
    const envelope = invocation.output.trim()
      ? JSON.parse(invocation.output).hookSpecificOutput
      : undefined;
    if (envelope) assert.equal(envelope.hookEventName, 'UserPromptSubmit');
    const text: string = envelope?.additionalContext ?? '';
    if (expected === 'MISSING') assert.equal(text, '', `${name}: injected irrelevant context`);
    else assert.ok(text.includes(expected), `${name}: expected memory not delivered`);
    for (const value of forbidden)
      assert.ok(!text.includes(value), `${name}: disallowed memory delivered`);
    const response = isCodex
      ? { is_error: false, result: readFileSync(join(work, 'answer.txt'), 'utf8') }
      : JSON.parse(output);
    if (isCodex) {
      const events = output
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      assert.ok(
        events.some((e) => e.type === 'turn.completed'),
        `${name}: turn did not complete`
      );
      const trustNotice =
        '`--dangerously-bypass-hook-trust` is enabled. Enabled hooks may run without review for this invocation.';
      const itemTypes = events
        .filter((e) => e.item && !(e.item.type === 'error' && e.item.message === trustNotice))
        .map((e) => e.item.type);
      assert.ok(
        itemTypes.every((type) => ['agent_message', 'reasoning', 'hook'].includes(type)),
        `${name}: unexpected items: ${itemTypes.join(', ')}`
      );
    }
    assert.equal(response.is_error, false, `${name}: model call failed`);
    if (assertAnswer)
      assert.ok(
        response.result.includes(expected),
        `${name}: model did not use the delivered memory`
      );
    checks.push({ name, passed: true, contextBytes: Buffer.byteLength(text) });
    process.stderr.write(`PASS ${name}\n`);
  };
  const question = 'What is the Quartz deployment passcode?';
  check('initial recall', question, alpha, markers.initial, [
    markers.other,
    markers.private,
    'soup',
  ]);
  check('fresh host process', question, alpha, markers.initial, [
    markers.other,
    markers.private,
    'soup',
  ]);
  check('project isolation', question, beta, markers.other, [
    markers.initial,
    markers.private,
    'soup',
  ]);
  check('explicit shared scope', 'What is the Helix team passcode?', alpha, markers.shared, [
    markers.private,
    'soup',
  ]);
  check(
    'no answer',
    'Who invented zebracorn astrophysics?',
    alpha,
    'MISSING',
    Object.values(markers)
  );
  client = await connect();
  try {
    await client.supersede({
      id: original.id,
      expectedRevision: original.revision,
      replacement: {
        content: `Quartz deployment passcode is ${markers.corrected}.`,
        kind: 'note',
        metadata: { status: 'accepted' },
      },
    });
  } finally {
    await client.close();
  }
  check('correction after restart', question, alpha, markers.corrected, [
    markers.initial,
    markers.other,
    markers.private,
    'soup',
  ]);
  if (values.selector) {
    check(
      'paraphrase',
      'Which credential unlocks the mineral-named release?',
      alpha,
      markers.corrected,
      [markers.initial, markers.other, markers.private, 'soup']
    );
    check(
      'verbose-task',
      'Please inspect the build scripts, explain any deployment problems, add appropriate tests and document how to use the Quartz deployment passcode.',
      alpha,
      markers.corrected,
      [markers.initial, markers.other, markers.private, 'soup']
    );
  }
  if (isCodex) {
    settings.hooks.UserPromptSubmit[0].hooks[0] = originalGenerated;
    writeFileSync(settingsPath, JSON.stringify(settings));
    check(
      'unwrapped generated command',
      question,
      alpha,
      markers.corrected,
      [markers.initial, markers.other, markers.private],
      false
    );
    settings.hooks.UserPromptSubmit[0].hooks[0] = generated;
    writeFileSync(settingsPath, JSON.stringify(settings));
  }

  // Real host transcript capture, explicit review, restart and correction.
  persistent = true;
  const capturedCode = 'C-' + randomUUID();
  const capturedQuestion = 'What is the Cobalt emergency passcode?';
  check(
    'native capture seed',
    `Remember: Cobalt emergency passcode is ${capturedCode}.`,
    alpha,
    'MISSING',
    Object.values(markers),
    true,
    false
  );
  const events = () =>
    existsSync(captureLog)
      ? readFileSync(captureLog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const stopped = events()
    .filter((e) => e.input.hook_event_name === 'Stop')
    .at(-1);
  assert.ok(stopped, 'Host must emit Stop');
  assert.equal(stopped.status, 0, stopped.stderr);
  client = await connect();
  let captured;
  try {
    captured = (
      await client.search({ namespaces: ['project/native/alpha'], text: capturedCode })
    ).items.find((r) => r.metadata.sourceRole === 'user');
    assert.ok(captured, 'Native transcript must yield a separately attributed user candidate');
    assert.equal(captured.metadata.status, 'candidate');
  } finally {
    await client.close();
  }
  check('unaccepted capture excluded', capturedQuestion, alpha, 'MISSING', [capturedCode]);
  run(
    process.execPath,
    [
      cli,
      'review',
      'accept',
      captured.id,
      '--profile',
      join(config, 'memorykit.profile.json'),
      '--expected-revision',
      String(captured.revision),
    ],
    alpha
  );
  check('accepted capture after restart', capturedQuestion, alpha, capturedCode, []);
  const replacementCode = 'C-' + randomUUID();
  run(
    process.execPath,
    [
      cli,
      'review',
      'correct',
      captured.id,
      '--profile',
      managedProfile,
      '--expected-revision',
      String(captured.revision + 1),
      '--text',
      `Cobalt emergency passcode is ${replacementCode}.`,
    ],
    alpha
  );
  check('captured correction after restart', capturedQuestion, alpha, replacementCode, [
    capturedCode,
  ]);
  const beforeCompact = events().filter((e) => e.input.hook_event_name === 'PreCompact').length;
  activeCheck = 'native compaction capture';
  const latestStop = events()
    .filter((e) => e.input.hook_event_name === 'Stop')
    .at(-1);
  assert.ok(latestStop?.input.session_id);
  const compactArgs = isCodex
    ? [
        'exec',
        'resume',
        latestStop.input.session_id,
        '--ignore-rules',
        '--dangerously-bypass-hook-trust',
        '--json',
        '-c',
        'model_auto_compact_token_limit=1',
        'Reply MISSING.',
      ]
    : [
        '-p',
        '/compact',
        '--resume',
        latestStop.input.session_id,
        '--output-format',
        'json',
        '--setting-sources',
        '',
        '--settings',
        settingsPath,
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--tools',
        '',
      ];
  run(executable, compactArgs, alpha);
  const compacts = events().filter((e) => e.input.hook_event_name === 'PreCompact');
  assert.ok(compacts.length > beforeCompact, 'Host must emit a native PreCompact event');
  assert.equal(compacts.at(-1).status, 0, compacts.at(-1).stderr);
  checks.push({ name: 'native compaction capture', passed: true, contextBytes: 0 });
  process.stderr.write('PASS native compaction capture\n');
  check('recall after native compaction', capturedQuestion, alpha, replacementCode, [capturedCode]);

  if (values.peer) {
    activeCheck = 'cross-host corrected capture recall';
    const peerHost = isCodex ? 'claude-code' : 'codex';
    const peerHome = join(work, 'peer-home');
    mkdirSync(peerHome);
    const peerSettings = join(peerHome, peerHost === 'codex' ? 'hooks.json' : 'settings.json');
    run(process.execPath, [
      cli,
      'install',
      '--profile',
      managedProfile,
      '--host',
      peerHost,
      '--settings',
      peerSettings,
    ]);
    if (peerHost === 'codex') {
      copyFileSync(
        join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
        join(peerHome, 'auth.json')
      );
      writeFileSync(join(peerHome, 'instructions.txt'), instructions);
      writeFileSync(
        join(peerHome, 'config.toml'),
        `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nmodel_reasoning_effort = "low"\nmodel_instructions_file = ${JSON.stringify(join(peerHome, 'instructions.txt').replaceAll('\\', '/'))}\n[features]\nshell_tool = false\napply_patch_freeform = false\n`
      );
    }
    const previousHome = env.CODEX_HOME;
    if (peerHost === 'codex') env.CODEX_HOME = peerHome;
    try {
      const peerOutput = run(
        values.peer,
        peerHost === 'codex'
          ? [
              'exec',
              '--ephemeral',
              '--ignore-rules',
              '--dangerously-bypass-hook-trust',
              '--json',
              '--output-last-message',
              join(peerHome, 'answer.txt'),
              capturedQuestion,
            ]
          : [
              '-p',
              capturedQuestion,
              '--output-format',
              'json',
              '--setting-sources',
              '',
              '--settings',
              peerSettings,
              '--strict-mcp-config',
              '--mcp-config',
              '{"mcpServers":{}}',
              '--tools',
              '',
              '--no-session-persistence',
              '--append-system-prompt',
              instructions,
            ],
        alpha
      );
      const answer =
        peerHost === 'codex'
          ? readFileSync(join(peerHome, 'answer.txt'), 'utf8')
          : JSON.parse(peerOutput).result;
      assert.ok(
        answer.includes(replacementCode),
        'Peer host must recall the reviewed correction from the same store'
      );
      assert.ok(!answer.includes(capturedCode), 'Peer must exclude the superseded source');
      checks.push({ name: 'cross-host corrected capture recall', passed: true, contextBytes: 0 });
    } finally {
      if (previousHome === undefined) delete env.CODEX_HOME;
      else env.CODEX_HOME = previousHome;
    }
    run(process.execPath, [
      cli,
      'uninstall',
      '--profile',
      managedProfile,
      '--host',
      peerHost,
      '--settings',
      peerSettings,
    ]);
  }

  // Small, descriptive fixture measurement, not a replacement for S18/S21's quality gates.
  activeCheck = 'descriptive retrieval measurements';
  client = await connect();
  const measurements: { category: string; expected: number; returned: number; relevant: number }[] =
    [];
  try {
    for (const [category, text, marker] of [
      ['exact', question, markers.corrected],
      ['paraphrase', 'Which credential unlocks the mineral-named release?', markers.corrected],
      ['no-answer', 'Who invented zebracorn astrophysics?', ''],
      [
        'verbose-task',
        'Please inspect the build scripts, explain any deployment problems, add appropriate tests and document how to use the Quartz deployment passcode.',
        markers.corrected,
      ],
    ]) {
      const result = await context(
        client,
        {
          namespace: 'project/native/alpha',
          sharedNamespaces: ['team/native'],
          text,
          deadlineMs: profile.recall?.deadlineMs,
        },
        undefined,
        profile.recall
          ? new CommandRecallSelector(
              profile.recall.id,
              profile.recall.command,
              profile.recall.discovery,
              profile.recall.verification,
              profile.recall.retries,
              profile.recall.budget
            )
          : undefined
      );
      measurements.push({
        category: category!,
        expected: marker ? 1 : 0,
        returned: result.items.length,
        relevant: marker && result.text.includes(marker) ? 1 : 0,
      });
    }
  } finally {
    await client.close();
  }
  // Remove instrumentation before exercising ownership-aware removal.
  activeCheck = 'native receipt and managed uninstall';
  writeFileSync(settingsPath, JSON.stringify(originalSettings));
  const receipt = JSON.parse(run(process.execPath, [cli, 'doctor', ...managedFlags], alpha));
  assert.ok(receipt.installation.lastInvocation, 'Native host must leave an invocation receipt');
  run(process.execPath, [cli, 'uninstall', ...managedFlags]);
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')).hooks, {});
  checks.push({ name: 'native receipt and managed uninstall', passed: true, contextBytes: 0 });
  const report = {
    host: values.host,
    version,
    installedCli: true,
    storage: values.storage,
    upgradedGeneratedConfiguration: true,
    checks,
    measurements,
    limitations:
      'Synthetic fixture only, not S18/S21 quality gates. Optional selection uses the explicitly configured provider. Codex hook trust bypass applies only to reviewed test hooks in an isolated temporary home; original user hooks/settings are never loaded. Zero contextBytes for the unwrapped command means output was not instrumented.',
    retrieval: profile.recall?.id ?? 'lexical',
    configurationFingerprint,
    generatedAt: new Date().toISOString(),
  };
  writeReport(report);
} catch (error) {
  // Keep failed native evidence reviewable without copying host output, paths or credentials.
  // The original assertion and bounded diagnostic still go to the local process log.
  writeReport({
    host: values.host,
    version,
    installedCli: true,
    storage: values.storage,
    checks: [...checks, { name: activeCheck, passed: false, contextBytes: 0 }],
    completed: false,
    configurationFingerprint,
    generatedAt: new Date().toISOString(),
    limitations: 'Native acceptance failed. Inspect the local diagnostic log; this partial report cannot qualify replacement readiness.',
  });
  throw error;
} finally {
  rmSync(work, { recursive: true, force: true });
}
