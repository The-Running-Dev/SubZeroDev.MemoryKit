// The compact item retrieve returns for a matched record (S15). Pure, so every storage
// provider projects records the same way; the provider locates the match with its own index.

import type { JsonValue, MemoryId, MemoryRecord, RetrievedItem } from './types.ts';

export const MAX_RETRIEVE_BYTES = 65_536;
export const MAX_EVIDENCE_REFS = 5;
export const MAX_EVIDENCE_REF_LENGTH = 256;
export const MAX_SUPERSEDED_IDS = 8;
// How many code points of context an excerpt keeps before the first matched term, at most a
// quarter of the excerpt so a short excerpt still holds the term.
const EXCERPT_LEAD = 40;

// The metadata's scalar values as one text, as the full-text index holds them.
export function metadataText(metadata: Record<string, JsonValue>): string {
  const parts: string[] = [];
  const walk = (value: JsonValue): void => {
    if (value === null) return;
    if (Array.isArray(value)) value.forEach(walk);
    else if (typeof value === 'object') Object.values(value).forEach(walk);
    else parts.push(String(value));
  };
  walk(metadata);
  return parts.join(' ');
}

export type RetrieveSource = Pick<
  MemoryRecord,
  | 'id'
  | 'revision'
  | 'namespace'
  | 'key'
  | 'kind'
  | 'state'
  | 'updatedAt'
  | 'content'
  | 'metadata'
  | 'provenance'
>;

// rank is the index's BM25 value, where lower is better; the score negates it so higher is
// better. supersededBy holds only the replacements the caller may read. terms are the query
// terms, which every match contains; anchor is the UTF-16 offset in the content where the
// index found the first of them, or -1 when only the kind or metadata matched.
export function retrievedItem(
  source: RetrieveSource,
  supersededBy: MemoryId[],
  rank: number,
  terms: string[],
  anchor: number,
  excerptChars: number
): RetrievedItem {
  const points = Array.from(source.content);
  let start = 0;
  if (anchor >= 0) {
    const lead = Math.min(EXCERPT_LEAD, Math.floor(excerptChars / 4));
    start = Math.max(0, Array.from(source.content.slice(0, anchor)).length - lead);
    start = Math.min(start, Math.max(0, points.length - excerptChars));
  }
  const end = Math.min(points.length, start + excerptChars);

  const allRefs = source.provenance.evidence.map((evidence) => evidence.ref);
  const refs = allRefs
    .filter((ref) => ref.length <= MAX_EVIDENCE_REF_LENGTH)
    .slice(0, MAX_EVIDENCE_REFS);
  const ids = supersededBy.slice(0, MAX_SUPERSEDED_IDS);

  return {
    id: source.id,
    revision: source.revision,
    namespace: source.namespace,
    key: source.key,
    kind: source.kind,
    state: source.state,
    updatedAt: source.updatedAt,
    contentBytes: Buffer.byteLength(source.content, 'utf8'),
    excerpt: {
      text: points.slice(start, end).join(''),
      truncated: start > 0 || end < points.length,
    },
    evidence: { refs, omitted: allRefs.length - refs.length },
    supersededBy: { ids, omitted: supersededBy.length - ids.length },
    match: { score: rank === 0 ? 0 : -rank, terms },
  };
}
