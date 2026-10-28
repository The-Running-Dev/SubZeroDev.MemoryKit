// The reranking configurations S21.3 compares, and the choice and gate of S21.4 and S21.5. Pure:
// lists are corpus refs in rank order, relevance is a reranker's sigmoid score, and nothing here
// loads a model.

import {
  DEPTH,
  HELD_NO_ANSWER,
  HELD_RECALL,
  applyRule,
  failedConditions,
  hardFailures,
  type Measured,
  type QueryLists,
} from './fusion.ts';

export const SOURCES = ['retrieve', 'any-word', 'fused'] as const;
export type Source = (typeof SOURCES)[number];
export const DEPTHS = [10, 20, 50];
export const THRESHOLDS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.3, 0.5, 0.7];
export const FUSED_FLOOR = 0.3;
export const COST_LIMIT_MS = 50;
export const COST_CONDITION = 'model time p95 per corpus query';

export interface RerankConfig {
  reranker: string;
  source: Source;
  depth: number;
  threshold: number;
}

export function configsFor(reranker: string): RerankConfig[] {
  return SOURCES.flatMap((source) =>
    DEPTHS.flatMap((depth) =>
      THRESHOLDS.map((threshold) => ({ reranker, source, depth, threshold }))
    )
  );
}

const SOURCE_NAMES: Record<Source, string> = {
  retrieve: 'S17 retrieve',
  'any-word': 'S17, any-word share',
  fused: `RRF of any-word and vector ≥ ${FUSED_FLOOR.toFixed(2)}`,
};

export const sourceLabel = (source: Source) => SOURCE_NAMES[source];

// The candidates a source offers one query, at DEPTH: S17's own list; S17 with any word shared;
// or the RRF of that list and the vector list at the floor.
export function sourceList(source: Source, lists: QueryLists): string[] {
  if (source === 'retrieve') return lists.strict.slice(0, DEPTH);
  if (source === 'any-word') return lists.relaxed.slice(0, DEPTH);
  return applyRule({ kind: 'fusion-relaxed', floor: FUSED_FLOOR }, lists, DEPTH);
}

// The first depth candidates whose relevance reaches the threshold, by relevance; equal
// relevance keeps the source's order, then the ref. Cut to the query's limit.
export function rerank(
  list: string[],
  depth: number,
  threshold: number,
  relevance: (ref: string) => number,
  limit: number
): string[] {
  const pool = list.slice(0, depth);
  const rank = new Map(pool.map((ref, i) => [ref, i]));
  return pool
    .filter((ref) => relevance(ref) >= threshold)
    .sort(
      (a, b) =>
        relevance(b) - relevance(a) || rank.get(a)! - rank.get(b)! || (a < b ? -1 : a > b ? 1 : 0)
    )
    .slice(0, limit);
}

export interface RerankCandidate {
  config: RerankConfig;
  modelBytes: number;
  costP95: number; // model time per corpus query at the configuration's source and depth
  corpus: Measured;
  heldout: Measured[]; // one per held-out set
}

// The S18.4 corpus conditions, and the cost condition of S21.4.
export function failedRerankConditions(c: RerankCandidate): string[] {
  const failed = failedConditions(c.corpus);
  return c.costP95 <= COST_LIMIT_MS ? failed : [...failed, COST_CONDITION];
}

// Highest recall@10, then MRR, then the fewest non-relevant, then the smaller model, then the
// smaller depth; then the order the configurations are listed.
function better(a: RerankCandidate, b: RerankCandidate): number {
  const x = a.corpus.overall;
  const y = b.corpus.overall;
  return (
    y.recall10 - x.recall10 ||
    y.mrr - x.mrr ||
    x.nonRelevant10 - y.nonRelevant10 ||
    a.modelBytes - b.modelBytes ||
    a.config.depth - b.config.depth
  );
}

export interface RerankChoice {
  chosen: RerankCandidate;
  qualified: boolean; // whether the chosen configuration meets every condition
  qualifying: number;
  gate: { passed: boolean; reasons: string[] };
}

export const configLabel = (c: RerankConfig) =>
  `${c.reranker} | ${sourceLabel(c.source)} | ${c.depth} | ≥ ${c.threshold}`;

export function chooseRerank(candidates: RerankCandidate[]): RerankChoice {
  const qualifying = candidates.filter((c) => failedRerankConditions(c).length === 0);
  const pool = qualifying.length > 0 ? qualifying : candidates;
  const chosen = [...pool].sort(better)[0];
  if (chosen === undefined) throw new Error('No candidates to choose from');
  const reasons: string[] = [];
  if (qualifying.length === 0) reasons.push('no configuration meets every corpus condition');
  chosen.heldout.forEach((set, i) => {
    if (!HELD_RECALL.met(set.overall.recall10)) {
      reasons.push(`held-out set ${i + 1} recall@10 ${set.overall.recall10.toFixed(3)} < 0.90`);
    }
    if (!HELD_NO_ANSWER.met(set.overall.noAnswerReturned)) {
      reasons.push(
        `held-out set ${i + 1} no-answer ${set.overall.noAnswerReturned.toFixed(3)} > 0.20`
      );
    }
  });
  for (const c of candidates) {
    const sets: Array<[string, Measured]> = [
      ['corpus', c.corpus],
      ...c.heldout.map((m, i): [string, Measured] => [`held-out set ${i + 1}`, m]),
    ];
    for (const [name, measured] of sets) {
      for (const failed of hardFailures(measured)) {
        reasons.push(`${configLabel(c.config)} breaks ${failed} on ${name}`);
      }
    }
  }
  return {
    chosen,
    qualified: qualifying.length > 0,
    qualifying: qualifying.length,
    gate: { passed: reasons.length === 0, reasons },
  };
}
