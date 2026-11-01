// Optional selector using an existing Claude Code login; no MCP, tools or project settings.
// The calling host can be any LLM. Pass an executable (not a Windows .cmd/.ps1 shim).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { instructions, schema } from './recall-prompt.mjs';

let work;
try {
  const { values } = parseArgs({
    options: {
      claude: { type: 'string', default: 'claude' },
      model: { type: 'string', default: 'haiku' },
    },
  });
  let raw = '';
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 65536 + 128) throw new Error('Input too large');
  }
  const request = JSON.parse(raw);
  if (request.version !== 1 || request.task !== 'select' || !Array.isArray(request.passages))
    throw new Error('Invalid request');
  work = mkdtempSync(join(tmpdir(), 'memorykit-selector-'));
  const env = { ...process.env };
  // A separate, tools-disabled headless selector is also usable from a Claude hook.
  delete env.CLAUDECODE;
  const result = spawnSync(
    values.claude,
    [
      '-p',
      JSON.stringify(request),
      '--model',
      values.model,
      '--output-format',
      'json',
      '--json-schema',
      JSON.stringify(schema),
      '--system-prompt',
      instructions,
      '--setting-sources',
      '',
      '--settings',
      '{"hooks":{}}',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      '',
      '--no-session-persistence',
    ],
    { cwd: work, env, encoding: 'utf8', windowsHide: true, timeout: 25000, maxBuffer: 1024 * 1024 }
  );
  if (result.status !== 0) throw new Error('Selector failed');
  const response = JSON.parse(result.stdout);
  if (response.is_error || !response.structured_output) throw new Error('Invalid model output');
  process.stdout.write(JSON.stringify(response.structured_output));
} catch {
  console.error('MemoryKit Claude recall failed; check executable, login, model and timeout.');
  process.exitCode = 1;
} finally {
  if (work) rmSync(work, { recursive: true, force: true });
}
