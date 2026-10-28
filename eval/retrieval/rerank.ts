// Reranking evaluation (S21). Scores each query's candidates from S18's lists with a local
// cross-encoder, keeps those whose relevance reaches a threshold, scores them as the S14 harness
// scores retrieve, and reports the comparison, the choice and gate of S21.4 and S21.5, and each
// reranker's cost.
//
//   npm run eval -- --rerank Xenova/ms-marco-MiniLM-L-6-v2,Xenova/ms-marco-TinyBERT-L-2-v2 [--allow-download]
//
// The model runtime is installed under eval/embed only and loaded from there at run time, so
// nothing else in the repository imports it. Without filler: the comparison is about ranking.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  METRICS_HEADER,
  METRICS_RULE,
  listsOf,
  loadSets,
  measured,
  megabytes,
  metrics,
  ms,
  ratio,
  scoreRanked,
  scoreRule,
  similarityFor,
  type CreateEmbedder,
  type Embedder,
  type Gathered,
  type QuerySet,
} from './embed.ts';
import { CONDITIONS, DEPTH, RRF_K, ruleLabel, type HybridRule, type Measured } from './fusion.ts';
import { percentiles, type Built, type QueryScore, type Timing } from './harness.ts';
import {
  COST_CONDITION,
  COST_LIMIT_MS,
  DEPTHS,
  FUSED_FLOOR,
  SOURCES,
  THRESHOLDS,
  chooseRerank,
  configLabel,
  configsFor,
  failedRerankConditions,
  rerank,
  sourceLabel,
  sourceList,
  type RerankCandidate,
  type RerankChoice,
  type Source,
} from './reranking.ts';

const RERANKER = new URL('../embed/reranker.ts', import.meta.url);
const EMBEDDER = new URL('../embed/embedder.ts', import.meta.url);
const COLD = fileURLToPath(new URL('../embed/cold-rerank.ts', import.meta.url));

// The vector list source (c) fuses, and the S18 rule kept as a reference row.
export const VECTOR_MODEL = 'Xenova/all-MiniLM-L6-v2';
const REFERENCE_RULES: HybridRule[] = [
  { kind: 'lexical', floor: null },
  { kind: 'fusion', floor: 0.4 },
];

export interface Reranker {
  model: string;
  revision: string;
  dtype: string;
  package: string;
  maxTokens: number;
  diskBytes: number;
  score(query: string, documents: string[]): Promise<number[]>; // relevance in [0, 1]
}

export type CreateReranker = (model: string, allowDownload: boolean) => Promise<Reranker>;

export interface Ranked extends RerankCandidate {
  scores: QueryScore[][]; // per query set: corpus, then each held-out set
}

export interface Reference {
  label: string;
  corpus: Measured;
  heldout: Measured[];
}

interface Costs {
  cold: Timing | null;
  scoring: Map<string, Timing>; // per source and depth
}

const costKey = (source: Source, depth: number) => `${source}|${depth}`;

export interface RerankEvaluation {
  sets: QuerySet[];
  embedder: Embedder;
  rerankers: Reranker[];
  references: Reference[];
  ranked: Ranked[];
  costs: Map<string, Costs>;
}

export async function evaluate(
  models: string[],
  allowDownload: boolean,
  repeat: number,
  create: { reranker?: CreateReranker; embedder?: CreateEmbedder } = {},
  measureCold = true
): Promise<RerankEvaluation> {
  const createReranker =
    create.reranker ??
    ((await import(RERANKER.href)) as { createReranker: CreateReranker }).createReranker;
  const createEmbedder =
    create.embedder ??
    ((await import(EMBEDDER.href)) as { createEmbedder: CreateEmbedder }).createEmbedder;
  const dir = mkdtempSync(join(tmpdir(), 'memorykit-rerank-'));
  try {
    const { built, sets } = await loadSets(dir);
    console.error(`Embedding with ${VECTOR_MODEL}...`);
    const embedder = await createEmbedder(VECTOR_MODEL, allowDownload);
    const similarity = await similarityFor(embedder, built, sets);
    const references = REFERENCE_RULES.map((rule): Reference => {
      const [corpus, ...heldout] = sets.map((set) =>
        measured(scoreRule(rule, set.gathered, built, similarity))
      );
      return {
        label: `${rule.kind === 'lexical' ? '—' : VECTOR_MODEL} | ${ruleLabel(rule)}`,
        corpus: corpus!,
        heldout,
      };
    });
    const content = (ref: string) => built.model.get(ref)!.content;
    const rerankers: Reranker[] = [];
    const ranked: Ranked[] = [];
    const costed = new Map<string, Costs>();
    for (const model of models) {
      console.error(`Reranking with ${model}...`);
      const reranker = await createReranker(model, allowDownload);
      rerankers.push(reranker);
      // Every pair any source offers at full depth, scored once per query text.
      const relevance = new Map<string, Map<string, number>>();
      for (const set of sets) {
        for (const entry of set.gathered) {
          if (entry.base.error !== null) continue;
          const text = entry.query.search.text ?? '';
          const { lists } = listsOf(entry, built, similarity);
          const known = relevance.get(text) ?? new Map<string, number>();
          relevance.set(text, known);
          const pool = [...new Set(SOURCES.flatMap((source) => sourceList(source, lists)))].filter(
            (ref) => !known.has(ref)
          );
          const scored = await reranker.score(text, pool.map(content));
          pool.forEach((ref, i) => known.set(ref, scored[i]!));
        }
      }
      const costs = await measureCosts(reranker, embedder, sets[0]!, built, similarity, repeat);
      if (measureCold) costs.cold = coldStart(model, repeat);
      costed.set(model, costs);
      for (const config of configsFor(model)) {
        const scores = sets.map((set) =>
          scoreRanked(set.gathered, built, similarity, (lists, limit, entry) => {
            const known = relevance.get(entry.query.search.text ?? '')!;
            return rerank(
              sourceList(config.source, lists),
              config.depth,
              config.threshold,
              (ref) => known.get(ref)!,
              limit
            );
          })
        );
        const [corpus, ...heldout] = scores.map(measured);
        ranked.push({
          config,
          modelBytes: reranker.diskBytes,
          costP95: costs.scoring.get(costKey(config.source, config.depth))!.p95,
          corpus: corpus!,
          heldout,
          scores,
        });
      }
    }
    return { sets, embedder, rerankers, references, ranked, costs: costed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Model time per corpus query, for each source and depth: scoring the query's candidates in one
// batch, and for the fused source embedding the query first. Each query `repeat` times.
async function measureCosts(
  reranker: Reranker,
  embedder: Embedder,
  corpus: QuerySet,
  built: Built,
  similarity: (entry: Gathered) => Map<string, number>,
  repeat: number
): Promise<Costs> {
  const scoring = new Map<string, Timing>();
  const entries = corpus.gathered
    .filter((entry) => entry.base.error === null)
    .map((entry) => ({
      text: entry.query.search.text ?? '',
      lists: listsOf(entry, built, similarity).lists,
    }));
  for (const source of SOURCES) {
    for (const depth of DEPTHS) {
      const samples: number[] = [];
      for (let i = 0; i < repeat; i++) {
        for (const { text, lists } of entries) {
          const documents = sourceList(source, lists)
            .slice(0, depth)
            .map((ref) => built.model.get(ref)!.content);
          const start = performance.now();
          if (source === 'fused') await embedder.embed(text, 'query');
          await reranker.score(text, documents);
          samples.push(performance.now() - start);
        }
      }
      scoring.set(costKey(source, depth), percentiles(samples));
    }
  }
  return { cold: null, scoring };
}

function coldStart(model: string, repeat: number): Timing {
  const cold: number[] = [];
  for (let i = 0; i < repeat; i++) {
    const child = spawnSync(process.execPath, ['--no-warnings', COLD, model], {
      encoding: 'utf8',
    });
    if (child.status !== 0) throw new Error(`Cold start failed: ${child.stderr}`);
    cold.push((JSON.parse(child.stdout.trim().split('\n').at(-1)!) as { ms: number }).ms);
  }
  return percentiles(cold);
}

const failedCount = (c: RerankCandidate) => failedRerankConditions(c).length || '—';

function candidateTable(ranked: Ranked[], set: number, conditions: boolean): string[] {
  return [
    `| Reranker | Source | Depth | Relevance | ${METRICS_HEADER} | Model p95 (ms)${conditions ? ' | Conditions failed' : ''} |`,
    `| --- | --- | --- | --- | ${METRICS_RULE} | ---${conditions ? ' | ---' : ''} |`,
    ...ranked.map((c) => {
      const m = set === 0 ? c.corpus : c.heldout[set - 1]!;
      const failed = conditions ? ` | ${failedCount(c)}` : '';
      return `| ${configLabel(c.config)} | ${metrics(m)} | ${ms(c.costP95)}${failed} |`;
    }),
  ];
}

function referenceTable(references: Reference[], sets: QuerySet[]): string[] {
  return [
    `| Set | Model | Rule | ${METRICS_HEADER} |`,
    `| --- | --- | --- | ${METRICS_RULE} |`,
    ...sets.flatMap((set, i) =>
      references.map((r) => {
        const m = i === 0 ? r.corpus : r.heldout[i - 1]!;
        return `| ${set.name} | ${r.label} | ${metrics(m)} |`;
      })
    ),
  ];
}

function choiceSection(choice: RerankChoice, sets: QuerySet[]): string[] {
  const chosen = choice.chosen;
  const cell = (m: Measured, t: (typeof CONDITIONS)[number]) => {
    try {
      const value = t.value(m.overall, m.categories, { p50: 0, p95: 0 });
      return `${Number.isInteger(value) ? value : value.toFixed(3)} ${t.met(value) ? '✓' : '✗'}`;
    } catch {
      return '—';
    }
  };
  return [
    '## Choice and gate',
    '',
    choice.qualified
      ? `${choice.qualifying} configurations meet every corpus condition and the cost condition; the chosen one is the first by recall@10, then MRR, then the fewest non-relevant results, then the smaller model, then the smaller depth.`
      : 'No configuration meets every corpus condition and the cost condition. The configuration named is the best by recall@10, then MRR, then the fewest non-relevant results, then the smaller model, then the smaller depth, and the gate fails.',
    '',
    `**${choice.qualified ? 'Chosen' : 'Best'}: ${chosen.config.reranker}, ${sourceLabel(chosen.config.source)}, depth ${chosen.config.depth}, relevance ≥ ${chosen.config.threshold}.**`,
    '',
    `**Gate: ${choice.gate.passed ? 'passed' : 'failed'}.**`,
    ...choice.gate.reasons.map((reason) => `- ${reason}`),
    '',
    `| Condition | Limit | ${sets.map((s) => s.name).join(' | ')} |`,
    `| --- | --- | ${sets.map(() => '---').join(' | ')} |`,
    ...CONDITIONS.map(
      (t) =>
        `| ${t.name} | ${t.limit} | ${[chosen.corpus, ...chosen.heldout].map((m) => cell(m, t)).join(' | ')} |`
    ),
    `| ${COST_CONDITION} (ms) | ≤ ${COST_LIMIT_MS} | ${ms(chosen.costP95)} ${chosen.costP95 <= COST_LIMIT_MS ? '✓' : '✗'} | ${sets
      .slice(1)
      .map(() => '—')
      .join(' | ')} |`,
    '',
    'The conditions choose on the corpus only. On the held-out sets the gate judges recall@10 and no-answer for the chosen configuration, and the hard conditions for every configuration.',
    '',
  ];
}

// The best configuration of each reranker and source on the corpus, by the order the choice uses,
// among those that meet every condition when any does.
function bestOfSources(ranked: Ranked[]): Ranked[] {
  const best = new Map<string, Ranked>();
  for (const c of ranked) {
    const key = `${c.config.reranker}|${c.config.source}`;
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, c);
      continue;
    }
    const pass = (r: Ranked) => (failedRerankConditions(r).length === 0 ? 1 : 0);
    const x = c.corpus.overall;
    const y = held.corpus.overall;
    const order =
      pass(c) - pass(held) ||
      x.recall10 - y.recall10 ||
      x.mrr - y.mrr ||
      y.nonRelevant10 - x.nonRelevant10 ||
      held.config.depth - c.config.depth;
    if (order > 0) best.set(key, c);
  }
  return [...best.values()];
}

export async function rerankReport(
  models: string[],
  allowDownload: boolean,
  repeat: number,
  environment: string,
  create?: { reranker?: CreateReranker; embedder?: CreateEmbedder }
): Promise<{ text: string; passed: boolean }> {
  const evaluation = await evaluate(models, allowDownload, repeat, create);
  const { sets, rerankers, references, ranked, embedder } = evaluation;
  const choice = chooseRerank(ranked);
  const chosen = choice.chosen as Ranked;
  const label = choice.qualified ? 'chosen' : 'best';
  const lines = [
    '# Reranking evaluation (S21)',
    '',
    environment,
    '',
    `Each query's candidates come from one of three sources, each at depth ${DEPTH}: S17's retrieve list; S17's list with any word shared; or the reciprocal rank fusion (k = ${RRF_K}) of that list and the ${VECTOR_MODEL} vector list at floor ${FUSED_FLOOR.toFixed(2)}. A cross-encoder scores the query text against each of the first ${DEPTHS.join(', ')} candidates' full content; relevance is the sigmoid of its logit. Candidates whose relevance reaches the threshold (${THRESHOLDS.join(', ')}) are ranked by relevance, ties by the source's order, then the ref, and cut to the query's limit. No filler notes.`,
    '',
    '## Models',
    '',
    '| Model | Revision | Package | dtype | Max input tokens | Size on disk |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rerankers.map(
      (r) =>
        `| ${r.model} | \`${r.revision}\` | ${r.package} | ${r.dtype} | ${r.maxTokens} | ${megabytes(r.diskBytes)} |`
    ),
    '',
    `Source (c) embeds with ${embedder.model} at \`${embedder.revision}\` (${embedder.dtype}), as in S18.`,
    '',
    ...choiceSection(choice, sets),
    '## Reference rows',
    '',
    ...referenceTable(references, sets),
    '',
    '## Best of each reranker and source on the corpus',
    '',
    ...candidateTable(bestOfSources(ranked), 0, true),
    '',
  ];
  sets.forEach((set, i) => {
    lines.push(
      `## Every configuration on ${set.name === 'corpus' ? 'the corpus' : set.name}`,
      '',
      ...candidateTable(ranked, i, i === 0),
      ''
    );
  });
  sets.forEach((set, i) => {
    lines.push(
      `## ${set.name === 'corpus' ? 'Corpus' : set.name} queries under the ${label} configuration`,
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
    '## Costs per reranker',
    '',
    `Cold start is a new process importing the runtime, loading the reranker and scoring one pair, ${repeat} times. Scoring is every corpus query's candidates at each depth in one batch, ${repeat} times; for the fused source it includes embedding the query with ${VECTOR_MODEL}. A query with fewer candidates than the depth scores what it has.`,
    '',
    `| Reranker | Size on disk | Cold start p50 / p95 (ms) | ${SOURCES.flatMap((s) => DEPTHS.map((d) => `${sourceLabel(s)}, depth ${d} p50 / p95 (ms)`)).join(' | ')} |`,
    `| --- | --- | --- | ${SOURCES.flatMap(() => DEPTHS.map(() => '---')).join(' | ')} |`,
    ...rerankers.map((r) => {
      const c = evaluation.costs.get(r.model)!;
      const cells = SOURCES.flatMap((s) => DEPTHS.map((d) => pair(c.scoring.get(`${s}|${d}`)!)));
      return `| ${r.model} | ${megabytes(r.diskBytes)} | ${c.cold === null ? '—' : pair(c.cold)} | ${cells.join(' | ')} |`;
    }),
    '',
    '## Notes',
    '',
    '- Reranked results are ranked here, outside retrieve, so their response bytes and latency are not measured; model time stands for the added cost.',
    `- A pair longer than a reranker's ${rerankers[0]?.maxTokens ?? 512} tokens is truncated; the memory's start is kept.`,
    `- The reference rows are S17 lexical and S18's best rule; neither is a candidate for the choice.`,
    ''
  );
  return { text: lines.join('\n'), passed: choice.gate.passed };
}
