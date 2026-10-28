// Retrieval evaluation report (S14). For each filler count it builds a fresh store from the
// synthetic corpus plus that many generated notes, runs every corpus query and reports quality,
// safety, cost and the thresholds recorded in 90-decisions.md (2026-10-27). Each query with text
// also runs through retrieve (S15), reported beside search.
//
//   node eval/retrieval/run.ts [--filler 0,10000] [--repeat 5] [--out report.md] [--json baseline.json]
//
// Latency is per call in this process. Bytes are the UTF-8 length of each result as JSON; the
// token figure is an estimate, ceil(bytes / 4), not a tokenizer count.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  THRESHOLDS,
  buildStore,
  byCategory,
  coldStart,
  loadCorpus,
  quality,
  runQueries,
  summarize,
  type Built,
  type Quality,
  type QueryScore,
  type Summary,
  type Timing,
} from './harness.ts';

interface Results {
  scores: QueryScore[];
  overall: Summary;
  categories: Map<string, Summary>;
}

interface Run extends Results {
  filler: number;
  retrieve: Results;
  indexing: Built['indexing'];
  cold: Timing;
}

const results = (scores: QueryScore[]): Results => ({
  scores,
  overall: summarize(scores),
  categories: byCategory(scores),
});

async function measure(filler: number, repeat: number): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), 'memorykit-eval-'));
  try {
    const corpus = loadCorpus();
    const built = await buildStore(dir, corpus, filler);
    const scores = await runQueries(dir, corpus, built, repeat);
    const retrieved = await runQueries(dir, corpus, built, repeat, 'retrieve');
    const cold = await coldStart(dir);
    return {
      filler,
      ...results(scores),
      retrieve: results(retrieved),
      indexing: built.indexing,
      cold,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(...args: string[]): string {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
}

const ms = (value: number) => value.toFixed(2);
const ratio = (value: number) => value.toFixed(3);
const tokens = (bytes: number) => Math.ceil(bytes / 4);
const size = (bytes: number) =>
  `${bytes.toLocaleString('en')} B (~${tokens(bytes).toLocaleString('en')} tokens)`;

function thresholds(runs: Run[]): string[] {
  const lines = [
    '| Threshold | Kind | Judged at filler | Limit | Measured | Met |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const threshold of THRESHOLDS) {
    const run = runs.find((r) => r.filler === threshold.filler);
    if (run === undefined) {
      lines.push(
        `| ${threshold.name} | ${threshold.kind} | ${threshold.filler.toLocaleString('en')} | ${threshold.limit} | not run | — |`
      );
      continue;
    }
    const judged = threshold.operation === 'retrieve' ? run.retrieve : run;
    const value = threshold.value(judged.overall, judged.categories, run.cold);
    const shown = Number.isInteger(value) ? String(value) : value.toFixed(3);
    lines.push(
      `| ${threshold.name} | ${threshold.kind} | ${threshold.filler.toLocaleString('en')} | ${threshold.limit} | ${shown} | ${threshold.met(value) ? 'yes' : '**no**'} |`
    );
  }
  return lines;
}

function summaryTable(rows: Array<[string, Summary]>): string[] {
  return [
    '| Category | Queries | Recall@5 | Recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors | Duplicates | Fetches needed | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      ([name, s]) =>
        `| ${name} | ${s.queries} | ${ratio(s.recall5)} | ${ratio(s.recall10)} | ${ratio(s.mrr)} | ${ratio(s.ndcg10)} | ${s.nonRelevant10.toFixed(2)} | ${s.noAnswer === 0 ? '—' : ratio(s.noAnswerReturned)} | ${s.obsolete} | ${s.exposure} | ${s.errors} | ${s.duplicates} | ${s.fetches} | ${s.pages} (${s.partialPages}) | ${ms(s.latency.p50)} / ${ms(s.latency.p95)} | ${s.bytes.p50} / ${s.bytes.p95} / ${s.bytes.max} |`
    ),
  ];
}

// search and retrieve over the queries both run: retrieve skips a query without text.
function comparison(run: Run): string[] {
  const ids = new Set(run.retrieve.scores.map((s) => s.id));
  const rows: Array<[string, Summary]> = [
    ['search', summarize(run.scores.filter((s) => ids.has(s.id)))],
    ['retrieve', run.retrieve.overall],
  ];
  const large = (results: Results) => results.categories.get('large-content')?.bytes.max ?? 0;
  return [
    '| Operation | Queries | Recall@10 | MRR | Obsolete | Exposure | Errors | Fetches needed | Fetches per answerable query | Pages (partial) | Latency p50 / p95 (ms) | Bytes per response p50 / p95 / max | Large-content bytes max |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      ([name, s]) =>
        `| ${name} | ${s.queries} | ${ratio(s.recall10)} | ${ratio(s.mrr)} | ${s.obsolete} | ${s.exposure} | ${s.errors} | ${s.fetches} | ${ratio(s.answerable === 0 ? 0 : s.fetches / s.answerable)} | ${s.pages} (${s.partialPages}) | ${ms(s.latency.p50)} / ${ms(s.latency.p95)} | ${s.bytes.p50} / ${s.bytes.p95} / ${s.bytes.max} | ${large(name === 'search' ? run : run.retrieve).toLocaleString('en')} |`
    ),
  ];
}

function report(runs: Run[], commit: string, dirty: boolean, repeat: number): string {
  const lines = [
    '# Retrieval evaluation',
    '',
    `Commit \`${commit || 'unknown'}\`${dirty ? ' (with uncommitted changes)' : ''}. Node ${process.version} on ${process.platform} ${process.arch}, ${cpus()[0]?.model ?? 'unknown CPU'}. Each query ran ${repeat} time(s); the first run is scored.`,
    '',
    'Queries without their own limit run at limit 10. Bytes are the UTF-8 length of each response as JSON. Tokens are estimated as ceil(bytes / 4), not counted by a tokenizer. Latency is per successful call, in process. Cold start is open plus one search, in process, on a closed store. Duplicates are reported, not scored or gated; each expected result counts once. A fetch is needed for a relevant result that came back without its whole content: a truncated retrieve excerpt, or content that differs from the expected revision.',
    '',
    'retrieve runs every query with text, at the default excerpt of 280 code points; `reject-limit` expects `ValidationFailed` from it, since retrieve bounds its limit itself.',
    '',
    '## Thresholds',
    '',
    'Recorded in `design/90-decisions.md` (2026-10-27) before the first run; the retrieve thresholds are S15.7. Hard thresholds gate CI; targets are reported, not gated.',
    '',
    ...thresholds(runs),
    '',
  ];
  for (const run of runs) {
    lines.push(
      `## ${run.filler.toLocaleString('en')} filler notes`,
      '',
      ...summaryTable([['overall', run.overall], ...run.categories]),
      '',
      'search and retrieve, over the queries with text:',
      '',
      ...comparison(run),
      '',
      '| Cost | Value |',
      '| --- | --- |',
      `| memories written | ${run.indexing.memories.toLocaleString('en')} |`,
      `| create p50 / p95 (ms) | ${ms(run.indexing.create.p50)} / ${ms(run.indexing.create.p95)} |`,
      `| lifecycle step p50 / p95 (ms) | ${ms(run.indexing.steps.p50)} / ${ms(run.indexing.steps.p95)} |`,
      `| build and check (s) | ${run.indexing.seconds.toFixed(1)} |`,
      `| database with WAL | ${(run.indexing.databaseBytes / 1_048_576).toFixed(1)} MiB |`,
      `| cold start p50 / p95 (ms) | ${ms(run.cold.p50)} / ${ms(run.cold.p95)} |`,
      `| response bytes p95 | ${size(run.overall.bytes.p95)} |`,
      `| response bytes max | ${size(run.overall.bytes.max)} |`,
      ''
    );
  }
  const base = runs[0]!;
  const retrieved = new Map(base.retrieve.scores.map((s) => [s.id, s]));
  const fetches = (s: QueryScore | undefined) =>
    s === undefined ? '—' : s.outcome === 'ok' ? String(s.fetches) : s.outcome;
  lines.push(
    `## Queries at ${base.filler.toLocaleString('en')} filler notes`,
    '',
    '| Query | Category | Outcome | First relevant rank | Recall@10 | Fetches needed, search / retrieve | Returned (top 5) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...base.scores.map(
      (s) =>
        `| ${s.id} | ${s.category} | ${s.outcome}${s.errorCode === null ? '' : ` (${s.errorCode})`} | ${s.rank ?? '—'} | ${s.relevant === 0 ? '—' : ratio(s.recall10)} | ${fetches(s)} / ${fetches(retrieved.get(s.id))} | ${s.returned.slice(0, 5).join(', ') || '—'} |`
    ),
    '',
    '## Known gaps',
    '',
    '- Search has no stemming or synonyms, so paraphrases that share no word with the memory are not found.',
    '- An earlier revision of a memory updated in place is reachable through `revision()`, not search; historical queries cover superseded memories only.',
    '- The large-content search returns one memory larger than the 32 KiB response target; the target is judged at p95, and the max is shown beside it. retrieve returns an excerpt of it, within the 64 KiB bound, and the full record takes a `get`.',
    '- Sparse metadata filters are measured as pages and partial pages at a scan budget of 10; storage does not report rows scanned.',
    ''
  );
  return lines.join('\n');
}

const { values } = parseArgs({
  options: {
    filler: { type: 'string', default: '0,10000' },
    repeat: { type: 'string', default: '5' },
    out: { type: 'string' },
    json: { type: 'string' },
  },
});
const repeat = Number(values.repeat);
const runs: Run[] = [];
for (const filler of values.filler.split(',').map(Number)) {
  console.error(`Evaluating with ${filler} filler notes...`);
  runs.push(await measure(filler, repeat));
}
const commit = git('rev-parse', 'HEAD');
const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
const text = report(runs, commit, dirty, repeat);
console.log(text);
if (values.out !== undefined) writeFileSync(values.out, text);
if (values.json !== undefined) {
  const baseline: {
    commit: string;
    dirty: boolean;
    runs: Array<{ filler: number; quality: Quality; retrieve: Quality }>;
  } = {
    commit,
    dirty,
    runs: runs.map((run) => ({
      filler: run.filler,
      quality: quality(run.scores),
      retrieve: quality(run.retrieve.scores),
    })),
  };
  writeFileSync(values.json, JSON.stringify(baseline, null, 2) + '\n');
}
