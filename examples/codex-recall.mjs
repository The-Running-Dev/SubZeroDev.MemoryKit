// Optional selector using an existing Codex login. No global config, hooks, MCP or tools.
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  instructions,
  schema,
  expansionInstructions,
  expansionSchema,
  verificationInstructions,
} from './recall-prompt.mjs';

let work;
try {
  const { values } = parseArgs({
    options: { codex: { type: 'string', default: 'codex' }, model: { type: 'string' } },
  });
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 131072) throw new Error('Input too large');
  }
  const request = JSON.parse(raw);
  if (request.version !== 1 || !['select', 'expand', 'verify'].includes(request.task))
    throw new Error('Invalid request');
  work = mkdtempSync(join(tmpdir(), 'memorykit-codex-selector-'));
  copyFileSync(
    join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'),
    join(work, 'auth.json')
  );
  writeFileSync(
    join(work, 'instructions.txt'),
    request.task === 'expand'
      ? expansionInstructions
      : request.task === 'verify'
        ? verificationInstructions
        : instructions
  );
  writeFileSync(
    join(work, 'schema.json'),
    JSON.stringify(request.task === 'expand' ? expansionSchema : schema)
  );
  writeFileSync(
    join(work, 'config.toml'),
    `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nmodel_reasoning_effort = "low"\nmodel_instructions_file = ${JSON.stringify(join(work, 'instructions.txt').replaceAll('\\', '/'))}\n[features]\nshell_tool = false\napply_patch_freeform = false\n`
  );
  const result = spawnSync(
    values.codex,
    [
      'exec',
      '--ephemeral',
      '--ignore-rules',
      '--skip-git-repo-check',
      '--json',
      '--output-schema',
      join(work, 'schema.json'),
      '--output-last-message',
      join(work, 'answer.json'),
      ...(values.model ? ['--model', values.model] : []),
      '-',
    ],
    {
      input: JSON.stringify(request),
      cwd: work,
      env: { ...process.env, CODEX_HOME: work },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 55000,
      maxBuffer: 1024 * 1024,
    }
  );
  if (result.status !== 0) throw new Error('Selector failed');
  const events = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  if (
    !events.some((e) => e.type === 'turn.completed') ||
    events.some(
      (e) => e.type === 'error' || (e.item && !['agent_message', 'reasoning'].includes(e.item.type))
    )
  )
    throw new Error('Unexpected model events');
  process.stdout.write(JSON.stringify(JSON.parse(readFileSync(join(work, 'answer.json'), 'utf8'))));
} catch {
  console.error('MemoryKit Codex recall failed; check executable, login, model and timeout.');
  process.exitCode = 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
}
