// Baseline numbers for later comparison, not targets. For each store size it times create,
// get, search, revision retrieval and the history drain on a fresh store with Git history,
// then reports the database and repository size.
//
//   node bench/baseline.ts [--sizes 1000,10000] [--out bench/baseline.md]
//
// Creates run while the drain lease is held, so they measure the write path alone and the
// whole backlog is then drained in one timed sync.

import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { EMBEDDED_PRINCIPAL, initStore, openService, type MemoryId } from '../src/index.ts';

const WORDS = [
  'alpha', 'bravo', 'cedar', 'delta', 'ember', 'falcon', 'garnet', 'harbor', 'island', 'juniper',
  'kestrel', 'lantern', 'meadow', 'nickel', 'orchid', 'pepper', 'quartz', 'raven', 'saffron',
  'timber', 'umber', 'violet', 'willow', 'xenon', 'yarrow', 'zephyr',
]; // prettier-ignore
const KINDS = ['note', 'fact', 'decision', 'preference'];
const SAMPLES = { get: 1_000, search: 200, revision: 200 };

// A small deterministic generator, so every run writes the same store.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

interface Timing {
  median: number;
  p95: number;
}

function summarize(samples: number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { median: at(0.5), p95: at(0.95) };
}

async function timed(count: number, run: (i: number) => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = performance.now();
    await run(i);
    samples.push(performance.now() - start);
  }
  return summarize(samples);
}

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}

interface Result {
  size: number;
  create: Timing;
  get: Timing;
  search: Timing;
  revision: Timing;
  drainPerSecond: number;
  drainSeconds: number;
  databaseBytes: number;
  repositoryBytes: number;
}

async function measure(size: number): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), 'memorykit-bench-'));
  try {
    const store = { path: dir, service: { historyWaitMs: 0, drainBudgetMs: 3_600_000 } };
    await initStore(store);
    const { service, close } = await openService(store);
    const client = service.as(EMBEDDED_PRINCIPAL);
    const next = random(size);
    const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
    const sentence = (words: number) => Array.from({ length: words }, () => pick(WORDS)).join(' ');

    const ids: MemoryId[] = [];
    const lease = await service.storage.acquireDrainLease('bench', 3_600_000);
    if (lease === null) throw new Error('The drain lease is held');
    const create = await timed(size, async (i) => {
      const outcome = await client.create({
        namespace: `bench/team-${i % 10}`,
        kind: pick(KINDS),
        content: sentence(40),
        metadata: { index: i, topic: pick(WORDS) },
      });
      ids.push(outcome.memory.id);
    });
    await service.storage.releaseDrainLease(lease.token);

    const drainStart = performance.now();
    const queue = await client.syncHistory({ budgetMs: 3_600_000 });
    const drainSeconds = (performance.now() - drainStart) / 1_000;
    if (queue.pending !== 0) throw new Error(`History did not drain: ${JSON.stringify(queue)}`);

    const get = await timed(SAMPLES.get, () => client.get(pick(ids)));
    const search = await timed(SAMPLES.search, () =>
      client.search({ namespaces: ['bench/*'], text: pick(WORDS), limit: 20 })
    );
    const revision = await timed(SAMPLES.revision, () => client.revision(pick(ids), 1));
    await close();
    return {
      size,
      create,
      get,
      search,
      revision,
      drainPerSecond: size / drainSeconds,
      drainSeconds,
      databaseBytes: sizeOf(join(dir, 'memory.db')),
      repositoryBytes: sizeOf(join(dir, 'history.git')),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ms = (value: number) => value.toFixed(2);
const mib = (bytes: number) => (bytes / 1_048_576).toFixed(1);

function report(results: Result[]): string {
  const header = `| Measure | ${results.map((r) => `${r.size.toLocaleString('en')} memories`).join(' | ')} |`;
  const rule = `| --- | ${results.map(() => '---').join(' | ')} |`;
  const row = (name: string, cell: (r: Result) => string) =>
    `| ${name} | ${results.map(cell).join(' | ')} |`;
  const timing = (name: string, key: 'create' | 'get' | 'search' | 'revision') =>
    row(`${name} median / p95 (ms)`, (r) => `${ms(r[key].median)} / ${ms(r[key].p95)}`);
  return [
    `Node ${process.version} on ${process.platform} ${process.arch}, ${cpus()[0]?.model ?? 'unknown CPU'}`,
    '',
    header,
    rule,
    timing('create', 'create'),
    timing('get', 'get'),
    timing('search', 'search'),
    timing('revision', 'revision'),
    row(
      'drain (revisions/s)',
      (r) => `${r.drainPerSecond.toFixed(1)} (${r.drainSeconds.toFixed(1)} s)`
    ),
    row('database (MiB)', (r) => mib(r.databaseBytes)),
    row('repository (MiB)', (r) => mib(r.repositoryBytes)),
    '',
  ].join('\n');
}

const { values } = parseArgs({
  options: { sizes: { type: 'string', default: '1000,10000' }, out: { type: 'string' } },
});
const results: Result[] = [];
for (const size of values.sizes.split(',').map(Number)) {
  console.error(`Measuring ${size} memories...`);
  results.push(await measure(size));
}
const table = report(results);
console.log(table);
if (values.out !== undefined) writeFileSync(values.out, table);
