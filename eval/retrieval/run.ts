// Retrieval evaluation report (S14). For each filler count it builds a fresh store from the
// synthetic corpus plus that many generated notes, runs every corpus query and reports quality,
// safety, cost and the thresholds recorded in 90-decisions.md (2026-10-27). Each query with text
// also runs through retrieve (S15), reported beside search. The held-out queries (S17.1) run
// against the same store and are reported apart; without filler, retrieve also runs under each
// precision rule in RULES (S17.2).
//
//   node eval/retrieval/run.ts [--filler 0,10000] [--repeat 5] [--out report.md] [--json baseline.json]
//   node eval/retrieval/run.ts --work [--sizes 10000,50000,100000] [--repeat 5] [--out work.md]
//
// Latency is per call in this process. Bytes are the UTF-8 length of each result as JSON; the
// token figure is an estimate, ceil(bytes / 4), not a tokenizer count.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { RETRIEVE_RULE, type RetrieveRule } from '../../src/storage-sqlite/index.ts';
import {
  HELDOUT_THRESHOLDS,
  RULES,
  THRESHOLDS,
  buildStore,
  byCategory,
  coldStart,
  loadCorpus,
  loadHeldout,
  quality,
  runQueries,
  summarize,
  type Built,
  type Quality,
  type QueryScore,
  type Summary,
  type Threshold,
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
  heldout: { search: Results; retrieve: Results };
  rules: Array<{ rule: RetrieveRule; results: Results }>; // without filler only
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
    const heldout = loadHeldout(corpus);
    const built = await buildStore(dir, corpus, filler);
    const scores = await runQueries(dir, corpus, built, repeat);
    const retrieved = await runQueries(dir, corpus, built, repeat, 'retrieve');
    const held = {
      search: results(await runQueries(dir, heldout, built, repeat)),
      retrieve: results(await runQueries(dir, heldout, built, repeat, 'retrieve')),
    };
    const rules = [];
    if (filler === 0) {
      for (const rule of RULES) {
        rules.push({
          rule,
          results: results(await runQueries(dir, corpus, built, 1, 'retrieve', rule)),
        });
      }
    }
    const cold = await coldStart(dir);
    return {
      filler,
      ...results(scores),
      retrieve: results(retrieved),
      heldout: held,
      rules,
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

// One threshold's row. A threshold naming a category the queries do not have is not judged.
function judged(threshold: Threshold, judged: Results | undefined, cold: Timing): string {
  const head = `| ${threshold.name} | ${threshold.kind} | ${threshold.filler.toLocaleString('en')} | ${threshold.limit} |`;
  if (judged === undefined) return `${head} not run | — |`;
  let value: number;
  try {
    value = threshold.value(judged.overall, judged.categories, cold);
  } catch {
    return `${head} no such queries | — |`;
  }
  const shown = Number.isInteger(value) ? String(value) : value.toFixed(3);
  return `${head} ${shown} | ${threshold.met(value) ? 'yes' : '**no**'} |`;
}

const THRESHOLD_HEAD = [
  '| Threshold | Kind | Judged at filler | Limit | Measured | Met |',
  '| --- | --- | --- | --- | --- | --- |',
];

function thresholds(runs: Run[]): string[] {
  return [
    ...THRESHOLD_HEAD,
    ...THRESHOLDS.map((threshold) => {
      const run = runs.find((r) => r.filler === threshold.filler);
      const results = threshold.operation === 'retrieve' ? run?.retrieve : run;
      return judged(threshold, results, run?.cold ?? { p50: 0, p95: 0 });
    }),
  ];
}

function heldoutThresholds(runs: Run[]): string[] {
  return [
    ...THRESHOLD_HEAD,
    ...HELDOUT_THRESHOLDS.map((threshold) => {
      const run = runs.find((r) => r.filler === threshold.filler);
      return judged(threshold, run?.heldout.retrieve, run?.cold ?? { p50: 0, p95: 0 });
    }),
  ];
}

const ruleName = (rule: RetrieveRule) =>
  `${rule.stopwords ? 'without' : 'with'} stopwords, share ≥ ${rule.minShare}, cut ${rule.cut}`;

function rules(run: Run): string[] {
  return [
    '| Rule | Exact recall@5 | Recall@10 | Paraphrase recall@10 | MRR | Non-relevant in top 10 | No-answer returned | Obsolete | Exposure | Errors |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.rules.map(({ rule, results: { overall: o, categories: c } }) => {
      const chosen = JSON.stringify(rule) === JSON.stringify(RETRIEVE_RULE) ? ' (chosen)' : '';
      return `| ${ruleName(rule)}${chosen} | ${ratio(c.get('exact')!.recall5)} | ${ratio(o.recall10)} | ${ratio(c.get('paraphrase')!.recall10)} | ${ratio(o.mrr)} | ${o.nonRelevant10.toFixed(2)} | ${ratio(o.noAnswerReturned)} | ${o.obsolete} | ${o.exposure} | ${o.errors} |`;
    }),
  ];
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
    `retrieve runs every query with text, at the default excerpt of 280 code points; \`reject-limit\` expects \`ValidationFailed\` from it, since retrieve bounds its limit itself. It matches any of the query's words in a stemmed index and keeps what its precision rule keeps: ${ruleName(RETRIEVE_RULE)}.`,
    '',
    '## Thresholds',
    '',
    "Recorded in `design/90-decisions.md` (2026-10-27) before the first run; the retrieve response thresholds are S15.7, and retrieve is held to the search thresholds by S17.3 and S17.4. Hard thresholds gate CI; targets are reported, not gated. These queries chose the precision rule, so retrieve's results on them are fitted.",
    '',
    ...thresholds(runs),
    '',
    '## Held-out queries',
    '',
    'Written in `heldout.json` before any S17 code ran against the corpus and never used to choose a parameter. They run against the same store as the corpus queries.',
    '',
    ...heldoutThresholds(runs),
    '',
  ];
  const fitted = runs.find((run) => run.rules.length > 0);
  if (fitted !== undefined) {
    lines.push(
      '## Precision rules',
      '',
      "retrieve under each rule compared for S17.2, over the corpus queries without filler. A memory is kept when it holds at least the share of the query's words and scores at least the cut times the best kept score; stopwords are dropped from the query unless nothing else is left. The rule chosen has the highest recall@10, then MRR, then the fewest non-relevant results.",
      '',
      ...rules(fitted),
      ''
    );
  }
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
      'Held-out queries:',
      '',
      ...summaryTable([
        ['search', run.heldout.search.overall],
        ['retrieve', run.heldout.retrieve.overall],
        ...[...run.heldout.retrieve.categories].map(([name, s]): [string, Summary] => [
          `retrieve, ${name}`,
          s,
        ]),
      ]),
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
    `## Held-out queries through retrieve at ${base.filler.toLocaleString('en')} filler notes`,
    '',
    '| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...base.heldout.retrieve.scores.map(
      (s) =>
        `| ${s.id} | ${s.category} | ${s.outcome} | ${s.rank ?? '—'} | ${s.relevant === 0 ? '—' : ratio(s.recall10)} | ${s.returned.slice(0, 5).join(', ') || '—'} |`
    ),
    '',
    '## Known gaps',
    '',
    '- Search matches every word exactly, with no stemming; retrieve matches any word under Porter stemming. Neither has synonyms, so a paraphrase that shares no stem with the memory is not found.',
    "- retrieve's precision rule is lexical: a no-answer query that shares half its words with a memory still returns it.",
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
    work: { type: 'boolean', default: false },
    sizes: { type: 'string', default: '10000,50000,100000' },
  },
});
const repeat = Number(values.repeat);
if (values.work) {
  const { workReport } = await import('./work.ts');
  const commit = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain', '--untracked-files=no') !== '';
  const environment = `Commit \`${commit || 'unknown'}\`${dirty ? ' (with uncommitted changes)' : ''}. Node ${process.version} on ${process.platform} ${process.arch}, ${cpus()[0]?.model ?? 'unknown CPU'}, SQLite ${process.versions.sqlite ?? 'unknown'}.`;
  const text = await workReport(values.sizes.split(',').map(Number), repeat, environment);
  console.log(text);
  if (values.out !== undefined) writeFileSync(values.out, text);
  process.exit(0);
}
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
    runs: Array<{ filler: number; quality: Quality; retrieve: Quality; heldout: Quality }>;
  } = {
    commit,
    dirty,
    runs: runs.map((run) => ({
      filler: run.filler,
      quality: quality(run.scores),
      retrieve: quality(run.retrieve.scores),
      heldout: quality(run.heldout.retrieve.scores),
    })),
  };
  writeFileSync(values.json, JSON.stringify(baseline, null, 2) + '\n');
}
