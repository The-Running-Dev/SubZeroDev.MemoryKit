// Retrieval evaluation (S14). Builds a store from the synthetic corpus, runs its queries through
// the SDK and scores the results against the corpus's hand-written expectations. Each query with
// text also runs through retrieve (S15), scored the same way. The held-out queries (S17.1) run
// against the same store and are scored apart.
//
// Ideas taken from QMD at 86d2365d17fc682e491c2c53d1e4a884aee8682a (test/eval-harness.ts):
// expected results are exact ids, a failed query is never scored as an empty result, and hit
// rank, latency and bytes are tracked separately. No QMD code is used.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  EMBEDDED_PRINCIPAL,
  MAX_RETRIEVE_BYTES,
  MemoryService,
  SqliteStorage,
  type Grant,
  type JsonValue,
  type MemoryClient,
  type MemoryId,
  type MemoryKitError,
  type MemoryState,
  type RetrieveResult,
  type SearchQuery,
  type SearchResult,
} from '../../src/index.ts';
import { DATABASE_FILE, initStore, openService } from '../../src/sdk/index.ts';
import { RETRIEVE_RULE, type RetrieveRule } from '../../src/storage-sqlite/index.ts';

export const CORPUS_FILE = new URL('corpus.json', import.meta.url);
export const HELDOUT_FILE = new URL('heldout.json', import.meta.url);

const NO_HISTORY = { provider: 'none' } as const;
export const TOP = 10;
const MAX_PAGES = 100;

export interface Expected {
  ref: string;
  revision: number;
}

interface MemorySpec {
  ref?: string;
  series?: string; // creates count memories, ref series + i, with {i} in content replaced
  count?: number;
  repeat?: number; // content is repeated this many times, one line each, with {i} replaced
  namespace: string;
  kind: string;
  content: string;
  metadata?: Record<string, JsonValue>;
}

interface StepSpec {
  op: 'update' | 'archive' | 'restore' | 'tombstone' | 'supersede';
  ref: string;
  content?: string;
  replacement?: Omit<MemorySpec, 'namespace'> & { ref: string; namespace?: string };
}

export interface QuerySpec {
  id: string;
  category: string;
  principal?: string;
  search: SearchQuery;
  relevant?: Expected[];
  error?: string; // the code the query must fail with
  retrieveError?: string; // the code retrieve fails with, where it differs from error
  paginate?: boolean; // follow every cursor and score the pages as one list
  scanBudget?: number; // run against storage opened with this scan budget
}

export interface Corpus {
  version: 1;
  principals: Record<string, Grant[]>;
  memories: MemorySpec[];
  steps: StepSpec[];
  queries: QuerySpec[];
}

export function loadCorpus(file: URL | string = CORPUS_FILE): Corpus {
  return JSON.parse(readFileSync(file, 'utf8')) as Corpus;
}

// The corpus with its queries replaced by the held-out ones. They were written before any S17
// code ran and never chose a parameter, so their results are reported apart from the corpus's.
export function loadHeldout(corpus: Corpus, file: URL | string = HELDOUT_FILE): Corpus {
  const { queries } = JSON.parse(readFileSync(file, 'utf8')) as { queries: QuerySpec[] };
  return { ...corpus, queries };
}

// The precision rules compared on the corpus's queries without filler (S17.2). RETRIEVE_RULE
// is the one chosen: the highest recall@10, then MRR, then the fewest non-relevant results.
export const RULES: RetrieveRule[] = [
  { minShare: 0, cut: 0, stopwords: false },
  { minShare: 0, cut: 0, stopwords: true },
  { minShare: 0.5, cut: 0, stopwords: true },
  { minShare: 0.67, cut: 0, stopwords: true },
  { minShare: 1, cut: 0, stopwords: true },
  { minShare: 0, cut: 0.35, stopwords: true },
  { minShare: 0.5, cut: 0.2, stopwords: true },
  RETRIEVE_RULE,
  { minShare: 0.5, cut: 0.5, stopwords: true },
  { minShare: 0.5, cut: 0.35, stopwords: false },
];

// What each memory should be once the steps have run, worked out from the corpus alone.
export interface ModelEntry {
  namespace: string;
  kind: string;
  content: string;
  metadata: Record<string, JsonValue>;
  state: MemoryState;
  revision: number;
}

function expand(spec: MemorySpec): Array<{ ref: string } & ModelEntry> {
  const fill = (text: string, i: number) => text.replaceAll('{i}', String(i));
  const content = (i: number) =>
    spec.repeat === undefined
      ? fill(spec.content, i)
      : Array.from({ length: spec.repeat }, (_, j) => fill(spec.content, j + 1)).join('\n');
  const entry = (ref: string, i: number) => ({
    ref,
    namespace: spec.namespace,
    kind: spec.kind,
    content: content(i),
    metadata: spec.metadata ?? {},
    state: 'active' as const,
    revision: 1,
  });
  const series = spec.series;
  if (series !== undefined) {
    return Array.from({ length: spec.count ?? 0 }, (_, i) => entry(series + (i + 1), i + 1));
  }
  if (spec.ref === undefined) throw new Error('A corpus memory needs a ref or a series');
  return [entry(spec.ref, 1)];
}

export function expectedModel(corpus: Corpus): Map<string, ModelEntry> {
  const model = new Map<string, ModelEntry>();
  const add = (entry: { ref: string } & ModelEntry) => {
    if (model.has(entry.ref)) throw new Error(`Duplicate corpus ref ${entry.ref}`);
    const { ref, ...rest } = entry;
    model.set(ref, rest);
  };
  for (const spec of corpus.memories) expand(spec).forEach(add);
  for (const step of corpus.steps) {
    const target = model.get(step.ref);
    if (target === undefined) throw new Error(`Unknown step ref ${step.ref}`);
    target.revision++;
    if (step.op === 'update') target.content = step.content ?? target.content;
    if (step.op === 'archive') target.state = 'archived';
    if (step.op === 'tombstone') target.state = 'tombstoned';
    if (step.op === 'restore') target.state = 'active';
    if (step.op === 'supersede') {
      target.state = 'superseded';
      const replacement = step.replacement!;
      expand({ ...replacement, namespace: replacement.namespace ?? target.namespace }).forEach(add);
    }
  }
  return model;
}

// A small deterministic generator, so every run writes the same filler.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

// Filler shares common words with the corpus, so it competes for rank, but is irrelevant to
// every query by definition.
const FILLER_WORDS = [
  'alpha', 'beta', 'service', 'data', 'worker', 'queue', 'release', 'cache', 'token', 'backup',
  'session', 'runbook', 'cluster', 'log', 'error', 'schema', 'review', 'team', 'index', 'node',
  'amber', 'basalt', 'cobalt', 'drift', 'ember', 'fjord', 'gravel', 'heron', 'inlet', 'jasper',
  'kelp', 'lichen', 'marrow', 'nettle', 'osprey', 'pumice', 'quill', 'rook', 'sorrel', 'tansy',
]; // prettier-ignore

function filler(count: number): Array<{ ref: string } & ModelEntry> {
  const next = random(count);
  const word = () => FILLER_WORDS[Math.floor(next() * FILLER_WORDS.length)]!;
  return Array.from({ length: count }, (_, i) => ({
    ref: `filler-${i + 1}`,
    namespace: i % 2 === 0 ? 'eval/alpha/filler' : 'eval/beta/filler',
    kind: 'note',
    content: Array.from({ length: 24 }, word).join(' '),
    metadata: {},
    state: 'active' as const,
    revision: 1,
  }));
}

export interface Timing {
  p50: number;
  p95: number;
}

export function percentiles(samples: number[]): Timing {
  if (samples.length === 0) return { p50: 0, p95: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!;
  return { p50: at(0.5), p95: at(0.95) };
}

async function timed<T>(samples: number[], run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await run();
  } finally {
    samples.push(performance.now() - start);
  }
}

export interface Built {
  ids: Map<string, MemoryId>; // ref to id, filler included
  refs: Map<MemoryId, string>;
  model: Map<string, ModelEntry>;
  indexing: {
    memories: number;
    create: Timing; // ms per memory
    steps: Timing; // ms per lifecycle step
    seconds: number;
    databaseBytes: number;
  };
}

function sizeOf(path: string): number {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + sizeOf(join(path, name)), 0);
}

// Writes the filler, then the corpus, then the steps, and checks every memory came out as the
// model says. A mismatch is a broken corpus or store, so it throws rather than scores.
export async function buildStore(dir: string, corpus: Corpus, fillerCount = 0): Promise<Built> {
  const model = expectedModel(corpus);
  const extra = filler(fillerCount);
  for (const entry of extra) {
    const { ref, ...rest } = entry;
    model.set(ref, rest);
  }
  await initStore({ path: dir, history: NO_HISTORY });
  const { service, close } = await openService({ path: dir, history: NO_HISTORY });
  const ids = new Map<string, MemoryId>();
  const creates: number[] = [];
  const steps: number[] = [];
  const started = performance.now();
  try {
    const client = service.as(EMBEDDED_PRINCIPAL);
    const create = async (entry: { ref: string } & ModelEntry) => {
      const outcome = await timed(creates, () =>
        client.create({
          namespace: entry.namespace,
          kind: entry.kind,
          content: entry.content,
          metadata: entry.metadata,
        })
      );
      ids.set(entry.ref, outcome.memory.id);
    };
    for (const entry of extra) await create(entry);
    for (const spec of corpus.memories) for (const entry of expand(spec)) await create(entry);

    const revisions = new Map<string, number>([...ids.keys()].map((ref) => [ref, 1]));
    for (const step of corpus.steps) {
      const id = ids.get(step.ref)!;
      const expectedRevision = revisions.get(step.ref)!;
      const outcome = await timed(steps, () => {
        switch (step.op) {
          case 'update':
            return client.update({ id, expectedRevision, content: step.content! });
          case 'supersede': {
            const { namespace, kind, content, metadata } = step.replacement!;
            return client.supersede({
              id,
              expectedRevision,
              replacement: { namespace, kind, content, metadata },
            });
          }
          default:
            return client[step.op]({ id, expectedRevision });
        }
      });
      revisions.set(step.ref, expectedRevision + 1);
      if (step.op === 'supersede') {
        const created = [outcome.memory, ...outcome.related].find((record) => record.id !== id)!;
        ids.set(step.replacement!.ref, created.id);
        revisions.set(step.replacement!.ref, 1);
      }
    }

    for (const [ref, entry] of model) {
      const record = await client.get(ids.get(ref)!);
      if (
        record.namespace !== entry.namespace ||
        record.state !== entry.state ||
        record.revision !== entry.revision ||
        record.kind !== entry.kind ||
        record.content !== entry.content ||
        !isDeepStrictEqual(record.metadata, entry.metadata)
      ) {
        throw new Error(`Store does not match the corpus model for ${ref}`);
      }
    }
    let stored = 0;
    let cursor: string | null = null;
    do {
      const page: SearchResult = await client.search({
        states: ['active', 'superseded', 'archived', 'tombstoned'],
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      });
      stored += page.items.length;
      cursor = page.nextCursor;
    } while (cursor !== null);
    if (stored !== model.size) {
      throw new Error(`The store holds ${stored} memories; the corpus model has ${model.size}`);
    }
  } finally {
    await close();
  }
  const seconds = (performance.now() - started) / 1_000;
  return {
    ids,
    refs: new Map([...ids].map(([ref, id]) => [id, ref])),
    model,
    indexing: {
      memories: ids.size,
      create: percentiles(creates),
      steps: percentiles(steps),
      seconds,
      databaseBytes: ['', '-wal']
        .map((suffix) => join(dir, DATABASE_FILE + suffix))
        .reduce((total, file) => total + (safeSize(file) ?? 0), 0),
    },
  };
}

function safeSize(file: string): number | null {
  try {
    return sizeOf(file);
  } catch {
    return null;
  }
}

// The harness's own namespace match, so exposure is judged independently of the code under test.
export function readable(grants: Grant[] | null, namespace: string): boolean {
  if (grants === null) return true;
  return grants.some(({ pattern, permissions }) => {
    if (!permissions.includes('read')) return false;
    if (pattern === '*') return true;
    if (!pattern.endsWith('/*')) return pattern === namespace;
    const base = pattern.slice(0, -2);
    return namespace === base || namespace.startsWith(base + '/');
  });
}

export type Outcome = 'ok' | 'expected-error' | 'wrong-error' | 'unexpected-error' | 'no-error';

export interface QueryScore {
  id: string;
  category: string;
  outcome: Outcome;
  errorCode: string | null;
  returned: string[]; // refs in rank order, `?<id>` for an id the corpus never created
  relevant: number;
  rank: number | null; // of the first relevant result, 1-based
  recall5: number;
  recall10: number;
  reciprocalRank: number;
  ndcg10: number;
  nonRelevant10: number;
  obsolete: number;
  exposure: number;
  duplicates: number; // results whose content repeats an earlier result's
  fetches: number; // relevant results that came back without their full content
  pages: number;
  partialPages: number;
  bytes: number[]; // per search response
  latencies: number[]; // ms per successful search call
}

export type Operation = 'search' | 'retrieve';

// A result as scoring sees it. search returns the whole content; retrieve returns an excerpt.
export interface Row {
  id: MemoryId;
  revision: number;
  content: string;
  complete: boolean; // content is the whole stored content
  supersededBy: MemoryId[];
}

function searchRows(page: SearchResult): Row[] {
  return page.items.map((record) => ({
    id: record.id,
    revision: record.revision,
    content: record.content,
    complete: true,
    supersededBy: record.supersededBy ?? [],
  }));
}

function retrieveRows(page: RetrieveResult): Row[] {
  return page.items.map((item) => ({
    id: item.id,
    revision: item.revision,
    content: item.excerpt.text,
    complete: !item.excerpt.truncated,
    supersededBy: item.supersededBy.ids,
  }));
}

export interface Execution {
  items: Row[];
  pages: number;
  partialPages: number;
  bytes: number[];
  error: string | null;
}

// A query without its own limit runs at the top 10, the page size the thresholds are judged at.
export async function execute(
  client: MemoryClient,
  query: QuerySpec,
  samples: number[],
  operation: Operation
) {
  const run: Execution = { items: [], pages: 0, partialPages: 0, bytes: [], error: null };
  const base: SearchQuery = { limit: TOP, ...query.search };
  try {
    let cursor: string | null = null;
    do {
      if (run.pages === MAX_PAGES) throw new Error(`More than ${MAX_PAGES} pages`);
      const next = cursor === null ? base : { ...base, cursor };
      const start = performance.now();
      let page: SearchResult | RetrieveResult;
      if (operation === 'search') {
        const found = await client.search(next);
        page = found;
        run.items.push(...searchRows(found));
      } else {
        const found = await client.retrieve({ ...next, text: next.text ?? '' });
        page = found;
        run.items.push(...retrieveRows(found));
      }
      samples.push(performance.now() - start);
      run.pages++;
      if (page.completeness === 'partial') run.partialPages++;
      run.bytes.push(Buffer.byteLength(JSON.stringify(page), 'utf8'));
      cursor = query.paginate === true ? page.nextCursor : null;
    } while (cursor !== null);
  } catch (error) {
    run.error = (error as Partial<MemoryKitError>).code ?? `Thrown: ${String(error)}`;
  }
  return run;
}

// Ranking metrics for one query, from whether each returned item, in rank order, is relevant.
// Gains are binary; the ideal ranking puts every relevant item first, up to the top 10.
export function rankMetrics(hits: boolean[], relevant: number) {
  const first = hits.indexOf(true);
  const found = (k: number) => hits.slice(0, k).filter(Boolean).length;
  const recall = (k: number) => (relevant === 0 ? 0 : found(k) / relevant);
  const gain = (i: number) => 1 / Math.log2(i + 2);
  const dcg = hits.slice(0, TOP).reduce((total, hit, i) => total + (hit ? gain(i) : 0), 0);
  const ideal = Array.from({ length: Math.min(relevant, TOP) }, (_, i) => gain(i));
  const idealSum = ideal.reduce((a, b) => a + b, 0);
  return {
    rank: first === -1 ? null : first + 1,
    recall5: recall(5),
    recall10: recall(TOP),
    reciprocalRank: first === -1 ? 0 : 1 / (first + 1),
    ndcg10: idealSum === 0 ? 0 : dcg / idealSum,
    nonRelevant10: Math.min(hits.length, TOP) - found(TOP),
  };
}

export function score(
  query: QuerySpec,
  expectedError: string | undefined,
  run: Execution,
  latencies: number[],
  built: Built,
  grants: Grant[] | null
): QueryScore {
  const expected = query.relevant ?? [];
  // Each expected result counts once, so a repeated item cannot lift recall.
  const unmatched = [...expected];
  const isHit = (item: Row) => {
    const i = unmatched.findIndex(
      ({ ref, revision }) => built.ids.get(ref) === item.id && item.revision === revision
    );
    if (i !== -1) unmatched.splice(i, 1);
    return i !== -1;
  };
  let outcome: Outcome;
  if (run.error !== null) {
    outcome =
      expectedError === undefined
        ? 'unexpected-error'
        : run.error === expectedError
          ? 'expected-error'
          : 'wrong-error';
  } else {
    outcome = expectedError === undefined ? 'ok' : 'no-error';
  }

  const items = run.items;
  const hits = items.map(isHit);

  const states = query.search.states;
  const current = states === undefined || (states.length === 1 && states[0] === 'active');
  let obsolete = 0;
  let exposure = 0;
  let fetches = 0;
  const seen = new Set<string>();
  let duplicates = 0;
  for (const [i, item] of items.entries()) {
    const ref = built.refs.get(item.id);
    const entry = ref === undefined ? undefined : built.model.get(ref);
    if (entry === undefined) {
      exposure++; // an id the corpus never created cannot be shown to be readable
      continue;
    }
    if (item.revision !== entry.revision || (current && entry.state !== 'active')) obsolete++;
    if (!readable(grants, entry.namespace)) exposure++;
    for (const other of item.supersededBy) {
      const otherRef = built.refs.get(other);
      const otherEntry = otherRef === undefined ? undefined : built.model.get(otherRef);
      if (otherEntry === undefined || !readable(grants, otherEntry.namespace)) exposure++;
    }
    if (hits[i] && (!item.complete || item.content !== entry.content)) fetches++;
    if (i < TOP) {
      if (seen.has(item.content)) duplicates++;
      seen.add(item.content);
    }
  }

  return {
    id: query.id,
    category: query.category,
    outcome,
    errorCode: run.error,
    returned: items.map((item) => built.refs.get(item.id) ?? `?${item.id}`),
    relevant: expected.length,
    ...rankMetrics(hits, expected.length),
    obsolete,
    exposure,
    duplicates,
    fetches,
    pages: run.pages,
    partialPages: run.partialPages,
    bytes: run.bytes,
    latencies,
  };
}

// The client a query runs as. A query with a scan budget, or a run with another retrieve rule,
// opens storage directly, because openService takes neither; both paths run the same
// MemoryService.
export async function withClient<T>(
  dir: string,
  corpus: Corpus,
  scanBudget: number | undefined,
  run: (clientFor: (principal?: string) => MemoryClient) => Promise<T>,
  retrieveRule?: RetrieveRule
): Promise<T> {
  const opened =
    scanBudget === undefined && retrieveRule === undefined
      ? await openService({ path: dir, history: NO_HISTORY })
      : await (async () => {
          const service = new MemoryService(
            new SqliteStorage({ path: join(dir, DATABASE_FILE), scanBudget, retrieveRule }),
            null,
            {}
          );
          await service.open();
          return { service, close: () => service.close() };
        })();
  try {
    return await run((principal) => {
      if (principal === undefined) return opened.service.as(EMBEDDED_PRINCIPAL);
      const grants = corpus.principals[principal];
      if (grants === undefined) throw new Error(`Unknown corpus principal ${principal}`);
      return opened.service.as({ id: principal, profile: 'local', grants });
    });
  } finally {
    await opened.close();
  }
}

// The queries an operation runs: retrieve requires text, so it skips a query without any.
export function queriesFor(corpus: Corpus, operation: Operation): QuerySpec[] {
  return corpus.queries.filter((q) => operation === 'search' || q.search.text !== undefined);
}

// Runs every query `repeat` times; the first run is scored and every run adds latency samples.
// retrieveRule replaces retrieve's precision rule, for the S17.2 comparison.
export async function runQueries(
  dir: string,
  corpus: Corpus,
  built: Built,
  repeat = 1,
  operation: Operation = 'search',
  retrieveRule?: RetrieveRule
): Promise<QueryScore[]> {
  const queries = queriesFor(corpus, operation);
  const budgets = [...new Set(queries.map((query) => query.scanBudget))];
  const scores = new Map<string, QueryScore>();
  for (const budget of budgets) {
    await withClient(
      dir,
      corpus,
      budget,
      async (clientFor) => {
        for (const query of queries.filter((q) => q.scanBudget === budget)) {
          const client = clientFor(query.principal);
          const latencies: number[] = [];
          const first = await execute(client, query, latencies, operation);
          for (let i = 1; i < repeat && first.error === null; i++) {
            await execute(client, query, latencies, operation);
          }
          const grants =
            query.principal === undefined ? null : (corpus.principals[query.principal] ?? []);
          const expectedError =
            operation === 'retrieve' ? (query.retrieveError ?? query.error) : query.error;
          scores.set(query.id, score(query, expectedError, first, latencies, built, grants));
        }
      },
      retrieveRule
    );
  }
  return queries.map((query) => scores.get(query.id)!);
}

// Open plus the first search, in this process, repeated on a closed store.
export async function coldStart(dir: string, times = 5): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < times; i++) {
    await timed(samples, async () => {
      const { service, close } = await openService({ path: dir, history: NO_HISTORY });
      try {
        await service.as(EMBEDDED_PRINCIPAL).search({ text: 'Alpha', limit: TOP });
      } finally {
        await close();
      }
    });
  }
  return percentiles(samples);
}

export interface Summary {
  queries: number;
  answerable: number;
  errors: number; // unexpected, wrong or missing errors
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
  nonRelevant10: number;
  noAnswer: number;
  noAnswerReturned: number; // share of no-answer queries that returned anything
  obsolete: number;
  exposure: number;
  duplicates: number;
  fetches: number;
  pages: number;
  partialPages: number;
  latency: Timing;
  bytes: Timing & { max: number }; // per response
}

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

export function summarize(scores: QueryScore[]): Summary {
  const ran = scores.filter((s) => s.outcome === 'ok');
  const answerable = ran.filter((s) => s.relevant > 0);
  const noAnswer = ran.filter((s) => s.relevant === 0);
  return {
    queries: scores.length,
    answerable: answerable.length,
    errors: scores.filter((s) => s.outcome !== 'ok' && s.outcome !== 'expected-error').length,
    recall5: mean(answerable.map((s) => s.recall5)),
    recall10: mean(answerable.map((s) => s.recall10)),
    mrr: mean(answerable.map((s) => s.reciprocalRank)),
    ndcg10: mean(answerable.map((s) => s.ndcg10)),
    nonRelevant10: mean(answerable.map((s) => s.nonRelevant10)),
    noAnswer: noAnswer.length,
    noAnswerReturned: mean(noAnswer.map((s) => (s.returned.length > 0 ? 1 : 0))),
    obsolete: sum(scores.map((s) => s.obsolete)),
    exposure: sum(scores.map((s) => s.exposure)),
    duplicates: sum(scores.map((s) => s.duplicates)),
    fetches: sum(scores.map((s) => s.fetches)),
    pages: sum(scores.map((s) => s.pages)),
    partialPages: sum(scores.map((s) => s.partialPages)),
    latency: percentiles(scores.flatMap((s) => s.latencies)),
    bytes: {
      ...percentiles(ran.flatMap((s) => s.bytes)),
      max: Math.max(0, ...ran.flatMap((s) => s.bytes)),
    },
  };
}

export function byCategory(scores: QueryScore[]): Map<string, Summary> {
  const categories = [...new Set(scores.map((s) => s.category))];
  return new Map(
    categories.map((category) => [
      category,
      summarize(scores.filter((s) => s.category === category)),
    ])
  );
}

// The numbers CI holds steady: they depend only on the corpus and the ranking, never on timing.
export function quality(scores: QueryScore[]) {
  const round = (value: number) => Math.round(value * 10_000) / 10_000;
  const pick = (s: Summary) => ({
    recall5: round(s.recall5),
    recall10: round(s.recall10),
    mrr: round(s.mrr),
    ndcg10: round(s.ndcg10),
    nonRelevant10: round(s.nonRelevant10),
    noAnswerReturned: round(s.noAnswerReturned),
    obsolete: s.obsolete,
    exposure: s.exposure,
    errors: s.errors,
    fetches: s.fetches,
    pages: s.pages,
    partialPages: s.partialPages,
  });
  return {
    overall: pick(summarize(scores)),
    categories: Object.fromEntries([...byCategory(scores)].map(([name, s]) => [name, pick(s)])),
    queries: Object.fromEntries(
      scores.map((s) => [s.id, { outcome: s.outcome, rank: s.rank, recall10: round(s.recall10) }])
    ),
  };
}

export type Quality = ReturnType<typeof quality>;

// Recorded in 90-decisions.md (2026-10-27) before the first run; never adjusted after one. The
// retrieve thresholds are S15.7's: the S14 size target, and the S15.4 bound on every response.
export interface Threshold {
  name: string;
  kind: 'hard' | 'target';
  operation?: Operation; // the operation whose results are judged; search when absent
  filler: number; // the filler count the threshold is judged at
  limit: string;
  value: (overall: Summary, categories: Map<string, Summary>, cold: Timing) => number;
  met: (value: number) => boolean;
}

const category = (categories: Map<string, Summary>, name: string) => {
  const found = categories.get(name);
  if (found === undefined) throw new Error(`The corpus has no ${name} queries`);
  return found;
};

// The S14 thresholds at filler 0 hold for search; S17.3 and S17.4 judge retrieve by the same ones.
const FITTED: Threshold[] = [
  { name: 'unauthorized exposure', kind: 'hard', filler: 0, limit: '= 0', value: (o) => o.exposure, met: (v) => v === 0 },
  { name: 'obsolete results in current answers', kind: 'hard', filler: 0, limit: '= 0', value: (o) => o.obsolete, met: (v) => v === 0 },
  { name: 'unexpected, wrong or missing errors', kind: 'hard', filler: 0, limit: '= 0', value: (o) => o.errors, met: (v) => v === 0 },
  { name: 'exact-identifier recall@5', kind: 'target', filler: 0, limit: '= 1.0', value: (_o, c) => category(c, 'exact').recall5, met: (v) => v === 1 },
  { name: 'overall recall@10', kind: 'target', filler: 0, limit: '≥ 0.90', value: (o) => o.recall10, met: (v) => v >= 0.9 },
  { name: 'paraphrase recall@10', kind: 'target', filler: 0, limit: '≥ 0.70', value: (_o, c) => category(c, 'paraphrase').recall10, met: (v) => v >= 0.7 },
  { name: 'overall MRR', kind: 'target', filler: 0, limit: '≥ 0.75', value: (o) => o.mrr, met: (v) => v >= 0.75 },
  { name: 'mean non-relevant items in top 10', kind: 'target', filler: 0, limit: '≤ 2', value: (o) => o.nonRelevant10, met: (v) => v <= 2 },
  { name: 'no-answer queries returning anything', kind: 'target', filler: 0, limit: '≤ 20%', value: (o) => o.noAnswerReturned, met: (v) => v <= 0.2 },
]; // prettier-ignore

export const THRESHOLDS: Threshold[] = [
  ...FITTED,
  { name: 'search p95 (ms)', kind: 'target', filler: 10_000, limit: '≤ 50', value: (o) => o.latency.p95, met: (v) => v <= 50 },
  { name: 'response bytes p95', kind: 'target', filler: 10_000, limit: '≤ 32 KiB', value: (o) => o.bytes.p95, met: (v) => v <= 32 * 1024 },
  { name: 'cold start p95 (ms)', kind: 'target', filler: 10_000, limit: '≤ 500', value: (_o, _c, cold) => cold.p95, met: (v) => v <= 500 },
  { name: 'retrieve response bytes p95', kind: 'target', operation: 'retrieve', filler: 10_000, limit: '≤ 32 KiB', value: (o) => o.bytes.p95, met: (v) => v <= 32 * 1024 },
  { name: 'retrieve large-content response bytes', kind: 'hard', operation: 'retrieve', filler: 10_000, limit: '≤ 64 KiB', value: (_o, c) => category(c, 'large-content').bytes.max, met: (v) => v <= MAX_RETRIEVE_BYTES },
  ...FITTED.map((t): Threshold => ({ ...t, name: `retrieve ${t.name}`, operation: 'retrieve' })),
  { name: 'retrieve p95 (ms)', kind: 'target', operation: 'retrieve', filler: 10_000, limit: '≤ 50', value: (o) => o.latency.p95, met: (v) => v <= 50 },
]; // prettier-ignore

// The thresholds judged on the held-out queries too: retrieve's at filler 0.
export const HELDOUT_THRESHOLDS: Threshold[] = THRESHOLDS.filter(
  (t) => t.operation === 'retrieve' && t.filler === 0
);
