import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { assessReadiness, probeRecall, recallFingerprint } from '../src/workflow/readiness.ts';
import type { RecallSelector } from '../src/workflow/index.ts';
import { runCli, tempDir } from './helpers.ts';

const config = { id: 'synthetic', command: { command: 'test', args: ['private-argument'] }, discovery: true, verification: true };
const load = (name: string) => JSON.parse(readFileSync(new URL('../docs/validation/' + name, import.meta.url), 'utf8'));
function evidence() {
  const quality = load('practical-codex-quality-final.json');
  quality.configurationFingerprint = recallFingerprint(config);
  quality.latencyMs.p95 = 9000;
  const nativeCodex = load('practical-native-codex.json'), nativeClaude = load('practical-native-claude.json');
  nativeCodex.configurationFingerprint = nativeClaude.configurationFingerprint = recallFingerprint(config);
  return { quality, nativeCodex, nativeClaude, replacement: load('practical-replacement.json') };
}

it('fails readiness closed on absent, partial, mismatched, failed or slow evidence', () => {
  assert.equal(assessReadiness(config, evidence()).ready, true);
  assert.equal(assessReadiness(config, {}).ready, false);
  assert.equal(assessReadiness(undefined, evidence()).ready, false);
  for (const mutate of [
    (e: ReturnType<typeof evidence>) => { e.quality.cases = ['focused']; },
    (e: ReturnType<typeof evidence>) => { e.quality.configurationFingerprint = 'old'; },
    (e: ReturnType<typeof evidence>) => { e.quality.latencyMs.p95 = 10001; },
    (e: ReturnType<typeof evidence>) => { e.quality.latencyMs.p95 = null; },
    (e: ReturnType<typeof evidence>) => { e.quality.rows[0].error = { code: 'timeout' }; },
    (e: ReturnType<typeof evidence>) => { e.quality.rows[0].falseInjections = 1; },
    (e: ReturnType<typeof evidence>) => { e.quality.rows = Array.from({ length: 58 }, () => ({})); },
    (e: ReturnType<typeof evidence>) => { e.nativeCodex.checks[0].passed = false; },
    (e: ReturnType<typeof evidence>) => { e.nativeClaude.configurationFingerprint = 'different'; },
    (e: ReturnType<typeof evidence>) => { e.replacement.checks.pop(); },
  ]) {
    const e = evidence(); mutate(e); assert.equal(assessReadiness(config, e).ready, false);
  }
  assert.equal(recallFingerprint(config), recallFingerprint({ ...config, retries: 0, deadlineMs: 60000 }));
  assert.notEqual(recallFingerprint(config), recallFingerprint({ ...config, budget: { passages: 12, passageChars: 768, bytes: 16384 } }));
  assert.ok(!JSON.stringify(assessReadiness(config, {})).includes('private-argument'));
});

it('synthetic health probes check evidence, abstention and verification with cancellation', async () => {
  const selector: RecallSelector = {
    id: 'probe',
    async select(request) { return request.query.includes('combination') ? [] : [{ id: 'probe-answer', revision: 1, quote: request.passages[0]!.content }]; },
    async verify(request, rows) { return request.query.includes('combination') ? [] : rows; },
  };
  assert.equal((await probeRecall(selector)).passed, true);
  assert.equal((await probeRecall({ ...selector, async select(request) { return [{ id: 'probe-noise', revision: 1, quote: request.passages[1]!.content }]; } })).passed, false);
  let aborted = false;
  const result = await probeRecall({ id: 'never', select(_request, signal) {
    signal!.addEventListener('abort', () => { aborted = true; });
    return new Promise(() => {});
  } }, 20);
  assert.equal(result.passed, false);
  assert.equal(aborted, true);
});

it('doctor reports absent readiness gates without invoking a provider or changing configuration', () => {
  const dir = tempDir(), output = join(dir, 'config');
  const setup = runCli(['setup', '--store', join(dir, 'store'), '--output', output, '--namespace', 'project/demo', '--history', 'none']);
  assert.equal(setup.status, 0, setup.stderr);
  const profile = join(output, 'memorykit.profile.json'), before = readFileSync(profile, 'utf8');
  const manifest = join(dir, 'evidence.json'); writeFileSync(manifest, '{}');
  const result = runCli(['doctor', '--profile', profile, '--readiness', manifest]);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.readiness.ready, false);
  assert.ok(report.readiness.blocked.includes('quality'));
  assert.ok(report.readiness.blocked.includes('providerHealth'));
  assert.ok(report.readiness.blocked.includes('localInstallation'));
  assert.equal(readFileSync(profile, 'utf8'), before);
});

it('doctor combines current owned hooks, an explicit provider probe and complete evidence', () => {
  const dir = tempDir(), output = join(dir, 'config');
  const setup = runCli(['setup', '--store', join(dir, 'store'), '--output', output, '--namespace', 'project/demo', '--history', 'none']);
  assert.equal(setup.status, 0, setup.stderr);
  const profilePath = join(output, 'memorykit.profile.json');
  const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
  profile.recall = { ...config, command: { command: process.execPath, args: ['--input-type=module', '-e', `
    let text=''; for await (const chunk of process.stdin) text+=chunk;
    const r=JSON.parse(text);
    const selections=r.task==='expand' || r.query.includes('combination') ? [] : [{id:'probe-answer',revision:1,quote:r.passages[0].content}];
    console.log(JSON.stringify(r.task==='expand' ? {queries:['bicycle']} : {selections}));
  `] } };
  writeFileSync(profilePath, JSON.stringify(profile));
  const settings = join(dir, 'settings.json');
  writeFileSync(settings, JSON.stringify({ hooks: {} }));
  const flags = ['--profile', profilePath, '--host', 'claude-code', '--settings', settings];
  const installed = runCli(['install', ...flags]);
  assert.equal(installed.status, 0, installed.stderr);
  const reports = evidence();
  reports.quality.configurationFingerprint = reports.nativeCodex.configurationFingerprint = reports.nativeClaude.configurationFingerprint = recallFingerprint(profile.recall);
  const manifest: Record<string, string> = {};
  for (const [key, report] of Object.entries(reports)) {
    manifest[key] = join(dir, key + '.json');
    writeFileSync(manifest[key]!, JSON.stringify(report));
  }
  const manifestPath = join(dir, 'evidence.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const before = readFileSync(settings, 'utf8');
  const result = runCli(['doctor', ...flags, '--provider-probe', '--readiness', manifestPath]);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.providerHealth.passed, true);
  assert.equal(report.installation.current, true);
  assert.equal(report.readiness.ready, true);
  assert.equal(readFileSync(settings, 'utf8'), before);
});
