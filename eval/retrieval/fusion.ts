// The ranking rules S18.3 compares, and the choice and gate of S18.4 and S18.5. Pure: lists are
// corpus refs in rank order, similarities are exact cosine, and nothing here loads a model.

import { HELDOUT_THRESHOLDS, type Summary, type Threshold } from './harness.ts';

export const RRF_K = 60;
export const DEPTH = 50; // each list's depth before fusion; retrieve's own limit bound
export const FLOORS = Array.from(
  { length: 11 },
  (_, i) => Math.round((0.3 + 0.05 * i) * 100) / 100
);

export type RuleKind =
  'lexical' | 'vector' | 'fusion' | 'fusion-relaxed' | 'gated' | 'gated-relaxed';

export interface HybridRule {
  kind: RuleKind;
  floor: number | null; // null for lexical alone
}

export const HYBRID_RULES: HybridRule[] = [
  { kind: 'lexical', floor: null },
  ...(['vector', 'fusion', 'fusion-relaxed', 'gated', 'gated-relaxed'] as const).flatMap((kind) =>
    FLOORS.map((floor) => ({ kind, floor }))
  ),
];

export function ruleLabel(rule: HybridRule): string {
  const names: Record<RuleKind, string> = {
    lexical: 'S17 lexical',
    vector: 'vector only',
    fusion: 'RRF',
    'fusion-relaxed': 'RRF, any-word lexical',
    gated: 'vector-gated RRF',
    'gated-relaxed': 'vector-gated RRF, any-word lexical',
  };
  return rule.floor === null ? names[rule.kind] : `${names[rule.kind]} ≥ ${rule.floor.toFixed(2)}`;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) throw new Error(`Vectors differ in length: ${a.length}, ${b.length}`);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

// What one query offers the rules: retrieve's own list at the query's limit, S17's list and the
// any-word list at DEPTH, the refs the query's filters and grants admit, and each one's
// similarity to the query.
export interface QueryLists {
  lexical: string[];
  strict: string[];
  relaxed: string[];
  eligible: string[];
  similarity: Map<string, number>;
}

const sim = (lists: QueryLists, ref: string) => lists.similarity.get(ref) ?? -Infinity;

// Higher similarity first; equal similarities in ref order, so every run ranks alike.
function vectorList(lists: QueryLists, floor: number, depth: number): string[] {
  return lists.eligible
    .filter((ref) => sim(lists, ref) >= floor)
    .sort((a, b) => sim(lists, b) - sim(lists, a) || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, depth);
}

// Reciprocal rank fusion: each list adds 1 / (k + rank) for the refs it holds. Ties go to the
// higher similarity, then the ref.
export function fuse(lists: string[][], similarity: (ref: string) => number, k = RRF_K): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((ref, i) => scores.set(ref, (scores.get(ref) ?? 0) + 1 / (k + i + 1)));
  }
  return [...scores.keys()].sort(
    (a, b) =>
      scores.get(b)! - scores.get(a)! ||
      similarity(b) - similarity(a) ||
      (a < b ? -1 : a > b ? 1 : 0)
  );
}

// The refs a rule returns for one query, cut to the query's limit.
export function applyRule(rule: HybridRule, lists: QueryLists, limit: number): string[] {
  if (rule.floor === null) return lists.lexical.slice(0, limit);
  const floor = rule.floor;
  if (rule.kind === 'vector') return vectorList(lists, floor, limit);
  const relaxed = rule.kind === 'fusion-relaxed' || rule.kind === 'gated-relaxed';
  const lexical = (relaxed ? lists.relaxed : lists.strict).slice(0, DEPTH);
  const fused = fuse([lexical, vectorList(lists, floor, DEPTH)], (ref) => sim(lists, ref));
  const gated = rule.kind === 'gated' || rule.kind === 'gated-relaxed';
  return (gated ? fused.filter((ref) => sim(lists, ref) >= floor) : fused).slice(0, limit);
}

export interface Measured {
  overall: Summary;
  categories: Map<string, Summary>;
}

export interface Candidate {
  model: string | null; // null for S17 lexical, which no model changes
  rule: HybridRule;
  corpus: Measured;
  heldout: Measured[]; // one per held-out set
}

// A threshold's value on a set, or undefined when the set has none of the category it names.
function valueOf(threshold: Threshold, measured: Measured): number | undefined {
  try {
    return threshold.value(measured.overall, measured.categories, { p50: 0, p95: 0 });
  } catch {
    return undefined;
  }
}

// The S18.4 conditions are the S17.3 thresholds on the corpus: every hard one and every target.
export const CONDITIONS = HELDOUT_THRESHOLDS;
const HARD = HELDOUT_THRESHOLDS.filter((t) => t.kind === 'hard');
export const HELD_RECALL = HELDOUT_THRESHOLDS.find((t) => t.name === 'retrieve overall recall@10')!;
export const HELD_NO_ANSWER = HELDOUT_THRESHOLDS.find(
  (t) => t.name === 'retrieve no-answer queries returning anything'
)!;

export function failedConditions(measured: Measured): string[] {
  return CONDITIONS.filter((t) => {
    const value = valueOf(t, measured);
    return value === undefined || !t.met(value);
  }).map((t) => t.name);
}

export function hardFailures(measured: Measured): string[] {
  return HARD.filter((t) => !t.met(valueOf(t, measured)!)).map((t) => t.name);
}

// Highest recall@10, then MRR, then the fewest non-relevant; then the order the rules are listed.
function better(a: Candidate, b: Candidate): number {
  const x = a.corpus.overall;
  const y = b.corpus.overall;
  return y.recall10 - x.recall10 || y.mrr - x.mrr || x.nonRelevant10 - y.nonRelevant10;
}

export interface Choice {
  chosen: Candidate;
  qualified: boolean; // whether the chosen rule meets every corpus condition
  qualifying: number;
  gate: { passed: boolean; reasons: string[] };
}

export function choose(candidates: Candidate[]): Choice {
  const qualifying = candidates.filter((c) => failedConditions(c.corpus).length === 0);
  const pool = qualifying.length > 0 ? qualifying : candidates;
  const chosen = [...pool].sort(better)[0];
  if (chosen === undefined) throw new Error('No candidates to choose from');
  const reasons: string[] = [];
  if (qualifying.length === 0) reasons.push('no rule meets every corpus condition');
  // Lexical alone is the S17 result, not a reason to build anything that embeds.
  if (chosen.model === null) reasons.push('the chosen rule uses no model');
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
        reasons.push(`${c.model ?? 'lexical'} ${ruleLabel(c.rule)} breaks ${failed} on ${name}`);
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
