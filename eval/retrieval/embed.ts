// Embedding evaluation (S18). Embeds every corpus memory and query with a local model, ranks
// each query by the rules in fusion.ts, scores them as the S14 harness scores retrieve, and
// reports the comparison, the choice and gate of S18.4 and S18.5, and each model's cost.
//
//   npm run eval -- --embed Xenova/all-MiniLM-L6-v2,Xenova/bge-small-en-v1.5 [--allow-download]
//
// The model runtime is installed under eval/embed only and loaded from there at run time, so
// nothing else in the repository imports it. Without filler: the comparison is about ranking.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Grant, SearchQuery, SearchResult } from '../../src/index.ts';
import { DEFAULT_EXCERPT_CHARS } from '../../src/model/validate.ts';
import { RETRIEVE_RULE, type RetrieveRule } from '../../src/storage-sqlite/index.ts';
import {
  CONDITIONS,
  DEPTH,
  FLOORS,
  HYBRID_RULES,
  RRF_K,
  applyRule,
  choose,
  cosine,
  failedConditions,
  ruleLabel,
  type Candidate,
  type Choice,
  type HybridRule,
  type Measured,
  type QueryLists,
} from './fusion.ts';
import {
  TOP,
  buildStore,
  byCategory,
  execute,
  loadCorpus,
  loadHeldout,
  percentiles,
  queriesFor,
  score,
  summarize,
  withClient,
  type Built,
  type Corpus,
  type Execution,
  type QueryScore,
  type QuerySpec,
  type Row,
  type Timing,
} from './harness.ts';

export const HELDOUT_2_FILE = new URL('heldout-2.json', import.meta.url);
const EMBEDDER = new URL('../embed/embedder.ts', import.meta.url);
const COLD = fileURLToPath(new URL('../embed/cold.ts', import.meta.url));
const SEARCH_PAGE = 100;

// S17's precision rule with its word share relaxed to any word (S18.3).
export const RELAXED_RULE: RetrieveRule = { ...RETRIEVE_RULE, minShare: 0 };

export interface Embedder {
  model: string;
  revision: string;
  dtype: string;
  prefix: string;
  pooling: string;
  package: string;
  dimensions: number;
  diskBytes: number;
  embed(text: string, role: 'query' | 'document'): Promise<Float32Array>;
}

export type CreateEmbedder = (model: string, allowDownload: boolean) => Promise<Embedder>;

// What one query offers every rule, gathered once: the retrieve run S17 makes, S17's list and
// the any-word list at DEPTH, and every memory the query's filters and grants admit, as retrieve
// would show one that matched no word.
export interface Gathered {
  query: QuerySpec;
  expectedError: string | undefined;
  grants: Grant[] | null;
  base: Execution;
  strict: Row[];
  relaxed: Row[];
  eligible: Row[];
}

function excerptRow(record: SearchResult['items'][number]): Row {
  const points = Array.from(record.content);
  return {
    id: record.id,
    revision: record.revision,
    content: points.slice(0, DEFAULT_EXCERPT_CHARS).join(''),
    complete: points.length <= DEFAULT_EXCERPT_CHARS,
    supersededBy: record.supersededBy ?? [],
  };
}

export async function gather(dir: string, corpus: Corpus): Promise<Gathered[]> {
  const queries = queriesFor(corpus, 'retrieve');
  if (queries.some((q) => q.scanBudget !== undefined || q.paginate === true)) {
    throw new Error('The embedding comparison runs one page of each query, without a scan budget');
  }
  const gathered = new Map<string, Gathered>();
  await withClient(
    dir,
    corpus,
    undefined,
    async (clientFor) => {
      for (const query of queries) {
        const client = clientFor(query.principal);
        const base = await execute(client, query, [], 'retrieve');
        const grants =
          query.principal === undefined ? null : (corpus.principals[query.principal] ?? []);
        const entry: Gathered = {
          query,
          expectedError: query.retrieveError ?? query.error,
          grants,
          base,
          strict: [],
          relaxed: [],
          eligible: [],
        };
        gathered.set(query.id, entry);
        if (base.error !== null) continue;
        const deep = { ...query, search: { ...query.search, limit: DEPTH } };
        const strict = await execute(client, deep, [], 'retrieve');
        if (strict.error !== null) throw new Error(`${query.id} failed at depth: ${strict.error}`);
        entry.strict = strict.items;
        const filters: SearchQuery = { ...query.search, limit: SEARCH_PAGE };
        delete filters.text;
        let cursor: string | null = null;
        do {
          const page = await client.search(cursor === null ? filters : { ...filters, cursor });
          entry.eligible.push(...page.items.map(excerptRow));
          cursor = page.nextCursor;
        } while (cursor !== null);
      }
    },
    RETRIEVE_RULE
  );
  await withClient(
    dir,
    corpus,
    undefined,
    async (clientFor) => {
      for (const entry of gathered.values()) {
        if (entry.base.error !== null) continue;
        const deep = { ...entry.query, search: { ...entry.query.search, limit: DEPTH } };
        const run = await execute(clientFor(entry.query.principal), deep, [], 'retrieve');
        if (run.error !== null) throw new Error(`${entry.query.id} failed at depth: ${run.error}`);
        entry.relaxed = run.items;
      }
    },
    RELAXED_RULE
  );
  return queries.map((query) => gathered.get(query.id)!);
}

// One gathered query's lists as corpus refs, and the row each ref was first read as.
export function listsOf(
  entry: Gathered,
  built: Built,
  similarity: (entry: Gathered) => Map<string, number>
): { lists: QueryLists; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const refsOf = (list: Row[]) =>
    list.map((row) => {
      const ref = built.refs.get(row.id) ?? `?${row.id}`;
      if (!rows.has(ref)) rows.set(ref, row);
      return ref;
    });
  const lists: QueryLists = {
    lexical: refsOf(entry.base.items),
    strict: refsOf(entry.strict),
    relaxed: refsOf(entry.relaxed),
    eligible: refsOf(entry.eligible),
    similarity: similarity(entry),
  };
  return { lists, rows };
}

// Scores every query by the refs a ranking returns from its lists. A query retrieve rejects is
// rejected under every ranking.
export function scoreRanked(
  gathered: Gathered[],
  built: Built,
  similarity: (entry: Gathered) => Map<string, number>,
  rank: (lists: QueryLists, limit: number, entry: Gathered) => string[]
): QueryScore[] {
  return gathered.map((entry) => {
    const { query, base } = entry;
    if (base.error !== null)
      return score(query, entry.expectedError, base, [], built, entry.grants);
    const { lists, rows } = listsOf(entry, built, similarity);
    const limit = query.search.limit ?? TOP;
    const items = rank(lists, limit, entry).map((ref) => rows.get(ref)!);
    const run: Execution = { ...base, items, bytes: [] };
    return score(query, entry.expectedError, run, [], built, entry.grants);
  });
}

// Scores every query under one rule. The lexical rule is retrieve's own run, bytes and all.
export function scoreRule(
  rule: HybridRule,
  gathered: Gathered[],
  built: Built,
  similarity: (entry: Gathered) => Map<string, number>
): QueryScore[] {
  if (rule.kind === 'lexical') {
    return gathered.map((entry) =>
      score(entry.query, entry.expectedError, entry.base, [], built, entry.grants)
    );
  }
  return scoreRanked(gathered, built, similarity, (lists, limit) => applyRule(rule, lists, limit));
}

export const measured = (scores: QueryScore[]): Measured => ({
  overall: summarize(scores),
  categories: byCategory(scores),
});

export interface QuerySet {
  name: string;
  gathered: Gathered[];
}

export interface Ranked extends Candidate {
  scores: QueryScore[][]; // per query set: corpus, then each held-out set
}

// Every rule over every query set, for one model's vectors; the lexical rule only once, with no
// model.
export function rankAll(
  sets: QuerySet[],
  built: Built,
  model: string | null,
  similarity: (entry: Gathered) => Map<string, number>
): Ranked[] {
  const rules = HYBRID_RULES.filter((rule) => (model === null) === (rule.kind === 'lexical'));
  return rules.map((rule) => {
    const scores = sets.map((set) => scoreRule(rule, set.gathered, built, similarity));
    const [corpus, ...heldout] = scores.map(measured);
    return { model, rule, corpus: corpus!, heldout, scores };
  });
}

interface Costs {
  cold: Timing;
  query: Timing;
  document: Timing & { perSecond: number };
  scan: Array<{ vectors: number; timing: Timing }>;
}

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function unitVectors(count: number, dimensions: number, next: () => number): Float32Array {
  const data = new Float32Array(count * dimensions);
  for (let i = 0; i < count; i++) {
    let norm = 0;
    for (let j = 0; j < dimensions; j++) {
      const value = next() * 2 - 1;
      data[i * dimensions + j] = value;
      norm += value * value;
    }
    norm = Math.sqrt(norm);
    for (let j = 0; j < dimensions; j++) data[i * dimensions + j]! /= norm;
  }
  return data;
}

// One exact-cosine pass over every vector, keeping the best TOP, as a vector rule would.
function scan(data: Float32Array, query: Float32Array, dimensions: number): number[] {
  const best: number[] = [];
  let queryNorm = 0;
  for (let j = 0; j < dimensions; j++) queryNorm += query[j]! * query[j]!;
  for (let offset = 0; offset < data.length; offset += dimensions) {
    let dot = 0;
    let norm = 0;
    for (let j = 0; j < dimensions; j++) {
      const value = data[offset + j]!;
      dot += value * query[j]!;
      norm += value * value;
    }
    const similarity = dot / Math.sqrt(norm * queryNorm);
    if (best.length < TOP || similarity > best[best.length - 1]!) {
      best.push(similarity);
      best.sort((a, b) => b - a);
      if (best.length > TOP) best.pop();
    }
  }
  return best;
}

async function costs(
  embedder: Embedder,
  documents: string[],
  queries: string[],
  repeat: number
): Promise<Costs> {
  const cold: number[] = [];
  for (let i = 0; i < repeat; i++) {
    const child = spawnSync(process.execPath, ['--no-warnings', COLD, embedder.model], {
      encoding: 'utf8',
    });
    if (child.status !== 0) throw new Error(`Cold start failed: ${child.stderr}`);
    cold.push((JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { ms: number }).ms);
  }
  const query: number[] = [];
  for (let i = 0; i < repeat; i++) {
    for (const text of queries) {
      const start = performance.now();
      await embedder.embed(text, 'query');
      query.push(performance.now() - start);
    }
  }
  const document: number[] = [];
  const started = performance.now();
  for (const text of documents) {
    const start = performance.now();
    await embedder.embed(text, 'document');
    document.push(performance.now() - start);
  }
  const seconds = (performance.now() - started) / 1000;
  const next = random(embedder.dimensions);
  const scans = [];
  for (const vectors of [10_000, 100_000]) {
    const data = unitVectors(vectors, embedder.dimensions, next);
    const probe = unitVectors(1, embedder.dimensions, next);
    const samples: number[] = [];
    for (let i = 0; i < Math.max(repeat, 10); i++) {
      const start = performance.now();
      scan(data, probe, embedder.dimensions);
      samples.push(performance.now() - start);
    }
    scans.push({ vectors, timing: percentiles(samples) });
  }
  return {
    cold: percentiles(cold),
    query: percentiles(query),
    document: { ...percentiles(document), perSecond: documents.length / seconds },
    scan: scans,
  };
}

// The corpus stored in dir, and its queries and both held-out sets gathered against it.
export async function loadSets(dir: string): Promise<{ built: Built; sets: QuerySet[] }> {
  const corpus = loadCorpus();
  const built = await buildStore(dir, corpus);
  const sets: QuerySet[] = [
    { name: 'corpus', gathered: await gather(dir, corpus) },
    { name: 'heldout.json', gathered: await gather(dir, loadHeldout(corpus)) },
    { name: 'heldout-2.json', gathered: await gather(dir, loadHeldout(corpus, HELDOUT_2_FILE)) },
  ];
  return { built, sets };
}

const queryTexts = (sets: QuerySet[]) => [
  ...new Set(sets.flatMap((set) => set.gathered.map((g) => g.query.search.text ?? ''))),
];

// Embeds every corpus memory and query text once; each query's similarity to every memory it
// may see.
export async function similarityFor(
  embedder: Embedder,
  built: Built,
  sets: QuerySet[]
): Promise<(entry: Gathered) => Map<string, number>> {
  const documents = new Map<string, Float32Array>();
  for (const ref of built.model.keys()) {
    documents.set(ref, await embedder.embed(built.model.get(ref)!.content, 'document'));
  }
  const queries = new Map<string, Float32Array>();
  for (const text of queryTexts(sets)) queries.set(text, await embedder.embed(text, 'query'));
  return (entry: Gathered) => {
    const query = queries.get(entry.query.search.text ?? '')!;
    return new Map(
      entry.eligible.map((row) => {
        const ref = built.refs.get(row.id)!;
        return [ref, cosine(documents.get(ref)!, query)];
      })
    );
  };
}

export interface Evaluation {
  sets: QuerySet[];
  embedders: Embedder[];
  ranked: Ranked[];
  costs: Map<string, Costs>;
}

export async function evaluate(
  models: string[],
  allowDownload: boolean,
  repeat: number,
  create?: CreateEmbedder,
  measureCosts = true
): Promise<Evaluation> {
  const createEmbedder =
    create ?? ((await import(EMBEDDER.href)) as { createEmbedder: CreateEmbedder }).createEmbedder;
  const dir = mkdtempSync(join(tmpdir(), 'memorykit-embed-'));
  try {
    const { built, sets } = await loadSets(dir);
    const ranked = rankAll(sets, built, null, () => new Map());
    const embedders: Embedder[] = [];
    const costed = new Map<string, Costs>();
    const refs = [...built.model.keys()];
    const texts = queryTexts(sets);
    for (const model of models) {
      console.error(`Embedding with ${model}...`);
      const embedder = await createEmbedder(model, allowDownload);
      embedders.push(embedder);
      const similarity = await similarityFor(embedder, built, sets);
      ranked.push(...rankAll(sets, built, model, similarity));
      if (measureCosts) {
        const contents = refs.map((ref) => built.model.get(ref)!.content);
        costed.set(model, await costs(embedder, contents, texts, repeat));
      }
    }
    return { sets, embedders, ranked, costs: costed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const ratio = (value: number) => value.toFixed(3);
export const ms = (value: number) => value.toFixed(value < 10 ? 2 : 1);
export const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
const name = (c: Candidate) => `${c.model ?? '—'} | ${ruleLabel(c.rule)}`;

function categoryValue(m: Measured, category: string, pick: (s: Measured['overall']) => number) {
  const found = m.categories.get(category);
  return found === undefined ? '—' : ratio(pick(found));
}

export function metrics(m: Measured): string {
  const o = m.overall;
  return [
    ratio(o.recall5),
    ratio(o.recall10),
    categoryValue(m, 'exact', (s) => s.recall5),
    categoryValue(m, 'paraphrase', (s) => s.recall10),
    ratio(o.mrr),
    ratio(o.ndcg10),
    o.nonRelevant10.toFixed(2),
    ratio(o.noAnswerReturned),
    o.obsolete,
    o.exposure,
    o.errors,
    o.duplicates,
    o.fetches,
  ].join(' | ');
}

export const METRICS_HEADER =
  'Recall@5 | Recall@10 | Exact recall@5 | Paraphrase recall@10 | MRR | nDCG@10 | Non-relevant in top 10 | No-answer returning anything | Obsolete | Exposure | Errors | Duplicates | Fetches';
export const METRICS_RULE = Array.from({ length: 13 }, () => '---').join(' | ');

function candidateTable(ranked: Ranked[], set: number, conditions: boolean): string[] {
  return [
    `| Model | Rule | ${METRICS_HEADER}${conditions ? ' | Conditions failed' : ''} |`,
    `| --- | --- | ${METRICS_RULE}${conditions ? ' | ---' : ''} |`,
    ...ranked.map((c) => {
      const m = set === 0 ? c.corpus : c.heldout[set - 1]!;
      const failed = conditions ? ` | ${failedConditions(m).length || '—'}` : '';
      return `| ${name(c)} | ${metrics(m)}${failed} |`;
    }),
  ];
}

function choiceSection(choice: Choice, sets: QuerySet[]): string[] {
  const chosen = choice.chosen as Ranked;
  return [
    '## Choice and gate',
    '',
    choice.qualified
      ? `${choice.qualifying} rules meet every corpus condition; the chosen one is the first by recall@10, then MRR, then the fewest non-relevant results.`
      : 'No rule meets every corpus condition. The rule named is the best by recall@10, then MRR, then the fewest non-relevant results, and the gate fails.',
    '',
    `**${choice.qualified ? 'Chosen' : 'Best'}: ${chosen.model ?? 'no model'}, ${ruleLabel(chosen.rule)}${chosen.rule.kind === 'lexical' ? '' : `, k = ${RRF_K}, depth ${DEPTH}`}.**`,
    '',
    `**Gate: ${choice.gate.passed ? 'passed' : 'failed'}.**`,
    ...choice.gate.reasons.map((reason) => `- ${reason}`),
    '',
    `| Condition | Limit | ${sets.map((s) => s.name).join(' | ')} |`,
    `| --- | --- | ${sets.map(() => '---').join(' | ')} |`,
    ...CONDITIONS.map((t) => {
      const cells = [chosen.corpus, ...chosen.heldout].map((m) => {
        try {
          const value = t.value(m.overall, m.categories, { p50: 0, p95: 0 });
          return `${Number.isInteger(value) ? value : value.toFixed(3)} ${t.met(value) ? '✓' : '✗'}`;
        } catch {
          return '—';
        }
      });
      return `| ${t.name} | ${t.limit} | ${cells.join(' | ')} |`;
    }),
    '',
    'The conditions choose on the corpus only. On the held-out sets the gate judges recall@10 and no-answer for the chosen rule, and the hard conditions for every rule.',
    '',
  ];
}

// The best of each kind of rule on the corpus, per model, by the order the choice uses.
function bestOfKinds(ranked: Ranked[]): Ranked[] {
  const best = new Map<string, Ranked>();
  for (const c of ranked) {
    const key = `${c.model ?? ''}|${c.rule.kind}`;
    const held = best.get(key);
    const x = c.corpus.overall;
    const y = held?.corpus.overall;
    if (
      y === undefined ||
      (x.recall10 - y.recall10 || x.mrr - y.mrr || y.nonRelevant10 - x.nonRelevant10) > 0
    ) {
      best.set(key, c);
    }
  }
  return [...best.values()];
}

export async function embedReport(
  models: string[],
  allowDownload: boolean,
  repeat: number,
  environment: string,
  create?: CreateEmbedder
): Promise<{ text: string; passed: boolean }> {
  const evaluation = await evaluate(models, allowDownload, repeat, create);
  const { sets, embedders, ranked } = evaluation;
  const choice = choose(ranked);
  const chosen = choice.chosen as Ranked;
  const label = choice.qualified ? 'chosen' : 'best';
  const lines = [
    '# Embedding evaluation (S18)',
    '',
    environment,
    '',
    `Each corpus memory's content and each query is embedded in this process from a local cache, with no filler notes. Similarity is exact cosine. Lists fuse by reciprocal rank (k = ${RRF_K}), each cut to depth ${DEPTH}, at floors ${FLOORS[0]!.toFixed(2)} to ${FLOORS.at(-1)!.toFixed(2)}; no reranker.`,
    '',
    '## Models',
    '',
    '| Model | Revision | Package | dtype | Pooling | Query prefix | Dimensions | Size on disk |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...embedders.map(
      (e) =>
        `| ${e.model} | \`${e.revision}\` | ${e.package} | ${e.dtype} | ${e.pooling} | ${e.prefix === '' ? 'none' : `\`${e.prefix.trim()}\``} | ${e.dimensions} | ${megabytes(e.diskBytes)} |`
    ),
    '',
    ...choiceSection(choice, sets),
    '## Best of each rule kind on the corpus',
    '',
    ...candidateTable(bestOfKinds(ranked), 0, true),
    '',
  ];
  sets.forEach((set, i) => {
    lines.push(
      `## Every rule on ${set.name === 'corpus' ? 'the corpus' : set.name}`,
      '',
      ...candidateTable(ranked, i, i === 0),
      ''
    );
  });
  sets.forEach((set, i) => {
    lines.push(
      `## ${set.name === 'corpus' ? 'Corpus' : set.name} queries under the ${label} rule`,
      '',
      '| Query | Category | Outcome | First relevant rank | Recall@10 | Returned (top 5) |',
      '| --- | --- | --- | --- | --- | --- |',
      ...chosen.scores[i]!.map(
        (s) =>
          `| ${s.id} | ${s.category} | ${s.outcome}${s.errorCode === null ? '' : ` (${s.errorCode})`} | ${s.rank ?? '—'} | ${s.relevant === 0 ? '—' : ratio(s.recall10)} | ${s.returned.slice(0, 5).join(', ') || '—'} |`
      ),
      ''
    );
  });
  const pair = (t: Timing) => `${ms(t.p50)} / ${ms(t.p95)}`;
  lines.push(
    '## Costs per model',
    '',
    `Cold start is a new process loading the model and embedding one query, ${repeat} times. Query embedding is every distinct query text, ${repeat} times; documents are every corpus memory once. The scan is exact cosine over seeded random unit vectors, keeping the top ${TOP}.`,
    '',
    '| Model | Cold start p50 / p95 (ms) | Query embedding p50 / p95 (ms) | Document p50 / p95 (ms) | Documents per second | Scan 10,000 p50 / p95 (ms) | Scan 100,000 p50 / p95 (ms) |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...embedders.map((e) => {
      const c = evaluation.costs.get(e.model)!;
      return `| ${e.model} | ${pair(c.cold)} | ${pair(c.query)} | ${pair(c.document)} | ${c.document.perSecond.toFixed(1)} | ${pair(c.scan[0]!.timing)} | ${pair(c.scan[1]!.timing)} |`;
    }),
    '',
    '## Notes',
    '',
    '- Fused and vector rules are ranked here, outside retrieve, so their response bytes and latency are not measured; S19 and S20 measure them for the rule they build.',
    `- A vector-only result's excerpt is the first ${DEFAULT_EXCERPT_CHARS} characters of its content, as retrieve shows a memory with no matching word.`,
    "- Each model's tokenizer truncates text at 512 tokens, and a longer memory is embedded from its start; MiniLM was trained on at most 256.",
    "- A query's vector candidates are every memory its filters, states and grants admit, read through search without text as the query's principal.",
    ''
  );
  return { text: lines.join('\n'), passed: choice.gate.passed };
}
