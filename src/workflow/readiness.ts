import { canonicalJson, isPlainObject, sha256Hex, toProblem } from '../model/index.ts';
import type { CommandProviderOptions } from '../providers-command/index.ts';
import type { RecallRequest, RecallSelection, RecallSelector } from './index.ts';

export interface RecallConfiguration {
  id: string;
  command: CommandProviderOptions;
  discovery?: boolean;
  verification?: boolean;
  retries?: number;
  deadlineMs?: number;
  budget?: RecallSelector['budget'];
}

// Reports bind to configuration without publishing arbitrary command arguments or credentials.
export function recallFingerprint(config: RecallConfiguration): string {
  return sha256Hex(canonicalJson({
    id: config.id, command: config.command,
    discovery: config.discovery === true, verification: config.verification === true,
    retries: config.retries ?? 0, deadlineMs: config.deadlineMs ?? 60000,
    budget: config.budget ?? { passages: 32, passageChars: 2048, bytes: 65536 },
  }));
}

/** Explicit synthetic probe. Never reads stored content, invokes hooks, caches or writes memories. */
export async function probeRecall(selector: RecallSelector, deadlineMs = 60000) {
  const controller = new AbortController();
  const started = performance.now();
  let timer: ReturnType<typeof setTimeout>;
  const run = async () => {
    const signal = controller.signal;
    const active = () => signal.throwIfAborted();
    if (selector.expand) await selector.expand('Where is the bicycle stored?', signal);
    active();
    const request: RecallRequest = {
      query: 'Where is the bicycle stored?', limit: 2,
      passages: [
        { id: 'probe-answer', revision: 1, namespace: 'probe/project', content: 'The bicycle is stored in the attic.', truncated: false },
        { id: 'probe-noise', revision: 1, namespace: 'probe/project', content: 'The umbrella is blue.', truncated: false },
      ],
    };
    const supported = (rows: RecallSelection[]) => rows.length === 1 && rows[0]!.id === 'probe-answer' &&
      rows[0]!.revision === 1 && rows[0]!.quote.trim().length > 0 && request.passages[0]!.content.includes(rows[0]!.quote);
    const selected = await selector.select(request, signal);
    active();
    if (!supported(selected)) return false;
    if (selector.verify && !supported(await selector.verify(request, selected, signal))) return false;
    active();
    const absent = { ...request, query: 'What is the bicycle lock combination?' };
    if ((await selector.select(absent, signal)).length !== 0) return false;
    active();
    if (selector.verify && (await selector.verify(absent, selected, signal)).length !== 0) return false;
    return true;
  };
  try {
    const passed = await Promise.race([run(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error('Provider probe deadline exceeded')); }, deadlineMs);
    })]);
    return { passed, elapsedMs: performance.now() - started, synthetic: true };
  } catch (error) {
    return { passed: false, elapsedMs: performance.now() - started, synthetic: true, problem: toProblem(error) };
  } finally { clearTimeout(timer!); controller.abort(); }
}

function object(value: unknown): Record<string, unknown> { return isPlainObject(value) ? value : {}; }
function checks(report: Record<string, unknown>, names: string[]): boolean {
  if (!Array.isArray(report.checks)) return false;
  return names.every((name) => (report.checks as unknown[]).some((v: unknown) => {
    const c = object(v); return c.name === name && c.passed === true;
  }));
}

/** Local evidence assessment; reports are user-supplied attestations, not authenticated proofs. */
export function assessReadiness(config: RecallConfiguration | undefined, evidence: {
  quality?: unknown; nativeCodex?: unknown; nativeClaude?: unknown; replacement?: unknown;
}, maxColdP95Ms = 10000) {
  const fingerprint = config ? recallFingerprint(config) : null;
  const q = object(evidence.quality), codex = object(evidence.nativeCodex), claude = object(evidence.nativeClaude);
  const replacement = object(evidence.replacement);
  const rows = Array.isArray(q.rows) ? q.rows.map(object).filter((r) => !r.skipped) : [];
  const quality = fingerprint !== null && q.configurationFingerprint === fingerprint && q.cases === 'all' &&
    q.taskQueries === true && q.discovery === true && q.verification === true && Number(q.fillerNewerThanFacts) >= 1000 &&
    rows.length >= 58 && new Set(rows.map((r) => r.id)).size === rows.length && rows.every((r) =>
      typeof r.id === 'string' && Array.isArray(r.actual) && Array.isArray(r.expected) && typeof r.ms === 'number' &&
      (r.noAnswer === true || r.passed === true || typeof r.recall === 'number') && !r.error && r.passed !== false && Number(r.falseInjections ?? 0) === 0 &&
      (r.noAnswer ? Array.isArray(r.actual) && r.actual.length === 0 : Number(r.recall ?? 1) >= 0.9));
  const p95 = object(q.latencyMs).p95;
  const latency = quality && typeof p95 === 'number' && Number.isFinite(p95) && p95 >= 0 && p95 <= maxColdP95Ms;
  const native = (r: Record<string, unknown>, host: string) => r.host === host && r.installedCli === true &&
    fingerprint !== null && r.configurationFingerprint === fingerprint && checks(r, [
      'initial recall', 'fresh host process', 'project isolation', 'correction after restart',
      'unaccepted capture excluded', 'accepted capture after restart', 'native compaction capture',
      'recall after native compaction', 'native receipt and managed uninstall',
    ]) && (r.checks as unknown[]).every((c) => object(c).passed === true);
  const migration = replacement.installedPackage === true && Array.isArray(replacement.checks) && [
    'pinned upstream export: plan, import and exact source coverage',
    'attributed review, reject, atomic correction and current-only recall',
    'changed-source reconciliation is read-only and preserves the correction',
    'SQLite to Markdown: identity, review, source coverage and retained Git revisions',
    'rollback into a fresh SQLite store preserves the reviewed correction and Git history',
  ].every((name) => (replacement.checks as unknown[]).includes(name));
  const gates = { quality, coldLatency: latency, nativeCodex: native(codex, 'codex'), nativeClaude: native(claude, 'claude-code'), migrationAndRollback: migration };
  return {
    ready: Object.values(gates).every(Boolean), configurationFingerprint: fingerprint,
    maxColdP95Ms, measuredColdP95Ms: typeof p95 === 'number' ? p95 : null,
    gates, blocked: Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => name),
    limitations: 'Local synthetic evidence for the configured provider. Does not establish host trust, live source cutover, physical erasure or readiness of another model, backend or package build.',
  };
}
