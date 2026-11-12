// S30: wall-clock floor of ONE minimal provider call through the real command adapter.
// Records every sample, failures and timeouts included. Changes no prompt, model or gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { percentiles } from '../eval/retrieval/harness.ts';

const { values } = parseArgs({
  options: {
    provider: { type: 'string' }, // codex | ollama
    arm: { type: 'string', multiple: true }, // codex: seeded|fresh ; ollama: label only
    samples: { type: 'string', default: '30' },
    'timeout-ms': { type: 'string', default: '90000' },
    model: { type: 'string' },
    codex: { type: 'string', default: 'codex' },
    ollama: { type: 'string', default: 'ollama' },
    output: { type: 'string' },
    'adapter-arg': { type: 'string', multiple: true },
  },
});
const provider = values.provider;
if (provider !== 'codex' && provider !== 'ollama') throw new Error('--provider codex|ollama');
const samples = Number(values.samples);
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('--samples');
const timeoutMs = Number(values['timeout-ms']);
const adapter = resolve(import.meta.dirname, '..', 'examples', `${provider}-recall.mjs`);
const adapterFile = provider === 'codex' ? adapter : resolve(import.meta.dirname, '..', 'examples', 'ollama-provider.mjs');

// One passage, one short question: the smallest real select request.
const request = JSON.stringify({
  version: 1,
  task: 'select',
  query: 'Where is the microphone?',
  limit: 3,
  passages: [{ id: 'a', revision: 1, namespace: 'project/floor', content: 'The microphone is in the cabinet.' }],
});

function run(arm: string, extra: string[]) {
  const rows: { ms: number; ok: boolean; status: number | null; timedOut: boolean }[] = [];
  const dir = mkdtempSync(join(tmpdir(), 'memorykit-floor-'));
  const timings = join(dir, 'timings.jsonl');
  try {
    const stop = () => spawnSync(values.ollama!, ['stop', values.model!], { encoding: 'utf8' });
    const adapterArgs = [adapterFile, '--timings', timings, '--timeout-ms', String(timeoutMs)];
    // Resident arm: one uncounted call loads the weights first (recorded in the report).
    let warmupMs: number | null = null;
    if (provider === 'ollama' && arm === 'resident') {
      const t = performance.now();
      spawnSync(process.execPath, [...adapterArgs, '--model', values.model!], { input: request, encoding: 'utf8', timeout: timeoutMs + 15000, windowsHide: true });
      warmupMs = performance.now() - t;
    }
    for (let i = 0; i < samples; i++) {
      if (provider === 'ollama' && arm === 'unloaded') stop(); // weights evicted before every sample
      const start = performance.now();
      const r = spawnSync(
        process.execPath,
        [adapterFile, '--timings', timings, '--timeout-ms', String(timeoutMs), ...(values.model ? ['--model', values.model] : []), ...(provider === 'codex' ? ['--codex', values.codex!] : []), ...extra],
        { input: request, encoding: 'utf8', timeout: timeoutMs + 15000, windowsHide: true }
      );
      const ms = performance.now() - start;
      const timedOut = r.error?.code === 'ETIMEDOUT' || r.status === 75;
      let ok = false;
      try { ok = r.status === 0 && Array.isArray(JSON.parse(r.stdout).selections); } catch { /* counted as failed */ }
      rows.push({ ms, ok, status: r.status, timedOut });
      process.stderr.write(`${provider}/${arm} ${i + 1}/${samples} ${Math.round(ms)} ms ${ok ? 'ok' : 'FAIL'}\n`);
    }
    let lifecycle: unknown[] = [];
    try { lifecycle = readFileSync(timings, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { /* none */ }
    const turn = lifecycle.map((l: any) => l.turnMs).filter(Number.isFinite) as number[];
    return {
      arm, warmupMs, samples: rows.length,
      failed: rows.filter((r) => !r.ok).length, timedOut: rows.filter((r) => r.timedOut).length,
      wallMs: percentiles(rows.map((r) => r.ms)), // all samples, failures included
      okWallMs: percentiles(rows.filter((r) => r.ok).map((r) => r.ms)),
      turnMs: percentiles(turn),
      rows,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const arms = values.arm?.length ? values.arm : provider === 'codex' ? ['seeded', 'fresh'] : ['unloaded', 'resident'];
const version = spawnSync(provider === 'codex' ? values.codex! : values.ollama!, ['--version'], { encoding: 'utf8' });
const gpu = spawnSync('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' });
const report = {
  version: 1, provider, at: new Date().toISOString(),
  executable: (version.stdout || version.stderr || 'unknown').trim().split('\n')[0],
  host: { platform: process.platform, release: release(), cpus: cpus().length, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
  gpuBefore: (gpu.stdout || 'none').trim(),
  request: 'one passage, one question, limit 3 (select)',
  results: arms.map((arm) => run(arm, provider === 'codex' && arm === 'fresh' ? ['--fresh-model-catalog'] : [...(values['adapter-arg'] ?? [])])),
  gpuAfter: (spawnSync('nvidia-smi', ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader'], { encoding: 'utf8' }).stdout || 'none').trim(),
  limit: 'Percentiles use the harness nearest-rank method. Wall time includes adapter spawn and CLI start. Not a quality or readiness qualification.',
};
const json = JSON.stringify(report, null, 2) + '\n';
if (values.output) {
  mkdirSync(dirname(values.output), { recursive: true });
  writeFileSync(values.output, json);
} else process.stdout.write(json);
