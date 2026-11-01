// Opt-in, credentialed acceptance test. Uses the installed Claude Code executable,
// an installed MemoryKit CLI, synthetic data, disabled tools/MCP and isolated settings.
// Never part of npm test: it makes real model calls using the host's existing login.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openStore } from '../src/sdk/index.ts';
import { context } from '../src/workflow/index.ts';

const { values } = parseArgs({
  options: {
    cli: { type: 'string' },
    claude: { type: 'string', default: 'claude' },
    report: { type: 'string' },
  },
});
assert.ok(values.cli, 'Supply --cli /absolute/path/to/installed/dist/cli/main.js');
const cli = resolve(values.cli);
assert.ok(existsSync(cli), 'Installed CLI does not exist');
const work = mkdtempSync(join(tmpdir(), 'memorykit-native-'));
const checks: { name: string; passed: boolean; contextBytes: number }[] = [];
const run = (command: string, args: string[], cwd = work, input?: string) => {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
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
  const version = run(values.claude!, ['--version']).trim();
  const store = join(work, 'store');
  const config = join(work, 'config with spaces');
  run(process.execPath, [cli, 'setup', '--store', store, '--output', config, '--history', 'none']);
  const profilePath = join(config, 'memorykit.profile.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.sharedNamespaces = ['team/native'];
  writeFileSync(profilePath, JSON.stringify(profile));
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
  const settings = JSON.parse(readFileSync(join(config, 'claude.settings.fragment.json'), 'utf8'));
  const generated = settings.hooks.UserPromptSubmit[0].hooks[0];
  const log = join(work, 'hook.json');
  const wrapper = join(work, 'observe-hook.cjs');
  writeFileSync(
    wrapper,
    `
const fs = require('node:fs');
const {spawnSync} = require('node:child_process');
const input = fs.readFileSync(0, 'utf8');
const result = spawnSync(${JSON.stringify(generated.command)}, ${JSON.stringify(generated.args)},
  {input, encoding:'utf8', windowsHide:true, timeout:30000});
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({input:JSON.parse(input), status:result.status, output:result.stdout}));
process.stdout.write(result.stdout || '');
process.stderr.write(result.stderr || '');
process.exit(result.status === 0 ? 0 : 1);
`
  );
  generated.command = process.execPath;
  generated.args = [wrapper];
  const settingsPath = join(work, 'settings.json');
  writeFileSync(settingsPath, JSON.stringify(settings));
  const check = (
    name: string,
    prompt: string,
    cwd: string,
    expected: string,
    forbidden: string[]
  ) => {
    if (existsSync(log)) rmSync(log);
    const output = run(
      values.claude!,
      [
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
        '--no-session-persistence',
        '--append-system-prompt',
        'Answer the question using supplied memory only. Reply with the passcode only. If memory has no answer, reply MISSING. Do not use tools.',
      ],
      cwd
    );
    assert.ok(existsSync(log), `${name}: native host did not invoke the hook`);
    const invocation = JSON.parse(readFileSync(log, 'utf8'));
    assert.equal(invocation.status, 0, `${name}: hook failed`);
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
    const response = JSON.parse(output);
    assert.equal(response.is_error, false, `${name}: model call failed`);
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

  // Small, descriptive fixture measurement, not a replacement for S18/S21's quality gates.
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
      const result = await context(client, {
        namespace: 'project/native/alpha',
        sharedNamespaces: ['team/native'],
        text,
      });
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
  const report = {
    host: 'claude-code',
    version,
    installedCli: true,
    checks,
    measurements,
    limitations:
      'Synthetic fixture only; lexical retrieval, no semantic quality claim. Codex is covered by hook subprocess tests, not this native run.',
  };
  const json = JSON.stringify(report, null, 2) + '\n';
  if (values.report) {
    const destination = resolve(values.report);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, json);
  }
  process.stdout.write(json);
} finally {
  rmSync(work, { recursive: true, force: true });
}
