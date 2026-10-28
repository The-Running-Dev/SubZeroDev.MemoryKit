// The compact item retrieve returns for a matched record (S15). Pure, so every storage
// provider projects records the same way.

import type { JsonValue, MemoryId, MemoryRecord, RetrievedItem } from './types.ts';
import { searchTerms } from './validate.ts';

export const MAX_RETRIEVE_BYTES = 65_536;
export const MAX_EVIDENCE_REFS = 5;
export const MAX_EVIDENCE_REF_LENGTH = 256;
export const MAX_SUPERSEDED_IDS = 8;
// How many code points of context an excerpt keeps before the first matched term, at most a
// quarter of the excerpt so a short excerpt still holds the term.
const EXCERPT_LEAD = 40;

// A token as the full-text index stores one: a run of letters, digits, private-use characters
// and marks, lowercased with the diacritics removed (unicode61 remove_diacritics 2).
const TOKEN = /[\p{L}\p{N}\p{Co}\p{M}]+/gu;

function fold(token: string): string {
  return token.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

interface Token {
  text: string;
  index: number; // UTF-16 offset in the source
}

function tokens(text: string): Token[] {
  const found: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const folded = fold(match[0]);
    if (folded !== '') found.push({ text: folded, index: match.index });
  }
  return found;
}

// Where the phrase's tokens first occur in a row, or -1.
function find(haystack: Token[], phrase: string[]): number {
  if (phrase.length === 0) return -1;
  outer: for (let i = 0; i + phrase.length <= haystack.length; i++) {
    for (let j = 0; j < phrase.length; j++) {
      if (haystack[i + j]!.text !== phrase[j]) continue outer;
    }
    return i;
  }
  return -1;
}

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
// better. supersededBy holds only the replacements the caller may read.
export function retrievedItem(
  source: RetrieveSource,
  supersededBy: MemoryId[],
  rank: number,
  text: string,
  excerptChars: number
): RetrievedItem {
  const content = tokens(source.content);
  const elsewhere = [tokens(source.kind), tokens(metadataText(source.metadata))];
  const terms: string[] = [];
  let first = -1; // UTF-16 offset of the earliest matched term in the content
  for (const term of new Set(searchTerms(text))) {
    const phrase = tokens(term).map((token) => token.text);
    const at = find(content, phrase);
    if (at >= 0) {
      const index = content[at]!.index;
      if (first < 0 || index < first) first = index;
    }
    if (at >= 0 || elsewhere.some((field) => find(field, phrase) >= 0)) terms.push(term);
  }

  const points = Array.from(source.content);
  let start = 0;
  if (first >= 0) {
    const lead = Math.min(EXCERPT_LEAD, Math.floor(excerptChars / 4));
    start = Math.max(0, Array.from(source.content.slice(0, first)).length - lead);
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
