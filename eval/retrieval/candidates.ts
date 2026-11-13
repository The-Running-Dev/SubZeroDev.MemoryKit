// S31: compare a local candidate source against the expansion call's candidate set. Pure: refs
// are `id@revision`, and nothing here loads a model or a store.

export interface CandidateCase {
  id: string;
  expected: string[]; // the records the case needs
  expansion: string[]; // candidates the expansion call led to
  source: string[]; // candidates a local source offers instead
}

export interface CandidateComparison {
  id: string;
  foundByExpansion: string[];
  foundBySource: string[];
  lost: string[]; // needed, found under expansion, missing from the source
  missedByBoth: string[];
  irrelevant: number; // source candidates the case does not need
  candidates: number;
}

export function compareCandidates(c: CandidateCase): CandidateComparison {
  const expansion = new Set(c.expansion);
  const source = new Set(c.source);
  const expected = new Set(c.expected);
  const foundByExpansion = c.expected.filter((ref) => expansion.has(ref));
  const foundBySource = c.expected.filter((ref) => source.has(ref));
  return {
    id: c.id,
    foundByExpansion,
    foundBySource,
    lost: foundByExpansion.filter((ref) => !source.has(ref)),
    missedByBoth: c.expected.filter((ref) => !expansion.has(ref) && !source.has(ref)),
    irrelevant: [...source].filter((ref) => !expected.has(ref)).length,
    candidates: source.size,
  };
}

export interface ComparisonSummary {
  cases: number;
  neededCases: number;
  losingCases: string[];
  lostRecords: number;
  meanCandidates: number;
  maxCandidates: number;
}

export function summarizeComparison(rows: CandidateComparison[]): ComparisonSummary {
  const total = rows.reduce((sum, r) => sum + r.candidates, 0);
  return {
    cases: rows.length,
    neededCases: rows.filter((r) => r.foundByExpansion.length + r.foundBySource.length > 0).length,
    losingCases: rows.filter((r) => r.lost.length > 0).map((r) => r.id),
    lostRecords: rows.reduce((sum, r) => sum + r.lost.length, 0),
    meanCandidates: rows.length === 0 ? 0 : total / rows.length,
    maxCandidates: rows.reduce((max, r) => Math.max(max, r.candidates), 0),
  };
}
