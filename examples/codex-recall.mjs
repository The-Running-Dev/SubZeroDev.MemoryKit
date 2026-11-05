// Optional selector using an existing Codex login. No global config, hooks, MCP or tools.
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { compactRecall } from './compact-recall.mjs';
import { codexProcess } from './codex-process.mjs';
import {
  expansionInstructions,
  expansionSchema,
} from './recall-prompt.mjs';

let work;
const start = performance.now();
let timingFile, task, processTiming, setupMs;
let catalogCopied = false, succeeded = false;
try {
  const { values } = parseArgs({
    options: {
      codex: { type: 'string', default: 'codex' },
      model: { type: 'string' },
      'timeout-ms': { type: 'string', default: '90000' },
      'fresh-model-catalog': { type: 'boolean', default: false },
      timings: { type: 'string' },
    },
  });
  timingFile = values.timings;
  const timeout = Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeout) || timeout < 1000 || timeout > 110000)
    throw new Error('Invalid timeout');
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 131072) throw new Error('Input too large');
  }
  const request = JSON.parse(raw);
  if (request.version !== 1 || !['select', 'expand', 'verify'].includes(request.task))
    throw new Error('Invalid request');
  task = request.task;
  const compact = compactRecall(request);
  work = mkdtempSync(join(tmpdir(), 'memorykit-codex-selector-'));
  const sourceHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  copyFileSync(join(sourceHome, 'auth.json'), join(work, 'auth.json'));
  // Only native catalog metadata, never sessions, settings, skills or retrieval output.
  // Codex owns freshness, executable-version and provider/auth identity validation.
  // Do not refresh its timestamp or write back into the user's home.
  if (!values['fresh-model-catalog']) {
    try {
      const source = join(sourceHome, 'models_cache.json');
      const stat = statSync(source);
      if (stat.isFile() && stat.size <= 8 * 1024 * 1024) {
        copyFileSync(source, join(work, 'models_cache.json'));
        catalogCopied = true;
      }
    } catch { /* Optional acceleration: native discovery handles an absent cache. */ }
  }
  writeFileSync(
    join(work, 'instructions.txt'),
    compact?.instructions ?? expansionInstructions
  );
  writeFileSync(
    join(work, 'schema.json'),
    JSON.stringify(compact?.schema ?? expansionSchema)
  );
  writeFileSync(
    join(work, 'config.toml'),
    `approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nmodel_reasoning_effort = "low"\nmodel_instructions_file = ${JSON.stringify(join(work, 'instructions.txt').replaceAll('\\', '/'))}\n[features]\nshell_tool = false\napply_patch_freeform = false\napps = false\nplugins = false\nremote_plugin = false\nskill_search = false\nsleep_tool = false\n`
  );
  setupMs = performance.now() - start;
  const result = await codexProcess(
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
      input: compact ? JSON.stringify(compact.input) : request.query,
      cwd: work,
      env: { ...process.env, CODEX_HOME: work },
      timeout,
    }
  );
  processTiming = result.timing;
  if (result.error?.code === 'ETIMEDOUT') {
    process.exitCode = 75;
    throw new Error('Selector timed out');
  }
  if (result.error || result.status !== 0) throw new Error('Selector failed');
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
  const output = JSON.parse(readFileSync(join(work, 'answer.json'), 'utf8'));
  process.stdout.write(JSON.stringify(compact ? compact.decode(output) : output));
  succeeded = true;
} catch {
  console.error('MemoryKit Codex recall failed; check executable, login, model and timeout.');
  process.exitCode ??= 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (timingFile) appendFileSync(timingFile, JSON.stringify({
    version: 1, task, succeeded, catalogCopied, setupMs,
    ...processTiming, adapterMs: performance.now() - start,
  }) + '\n', { mode: 0o600 });
}
