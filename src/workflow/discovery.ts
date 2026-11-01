import type { MemoryRecord, SearchQuery } from '../model/index.ts';
import { ValidationFailedError } from '../model/index.ts';
import type { MemoryClient } from '../service/index.ts';
import type { RecallSelector } from './index.ts';

const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have how i if in is it its me my of on or our please should that the their them then there these they this to use was we were what when where which who why will with would you your'.split(
    ' '
  )
);

export function discoveryTerms(query: string): string[] {
  return [
    ...new Set(
      (query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []).filter(
        (word) => word.length > 1 && !STOP.has(word)
      )
    ),
  ];
}

// Query the provider's full search index, rather than only the newest records. Generated
// queries are search data: they cannot choose scopes, filters, providers or executables.
export async function discover(
  client: MemoryClient,
  query: SearchQuery,
  text: string,
  recent: MemoryRecord[],
  selector: RecallSelector,
  eligible: (record: MemoryRecord) => boolean,
  bound: number,
  reasons: Set<string>
): Promise<{ records: MemoryRecord[]; terms: string[] }> {
  const words = discoveryTerms(text);
  const generated = selector.expand ? await selector.expand(text) : [];
  if (
    !Array.isArray(generated) ||
    generated.length > 8 ||
    generated.some((q) => typeof q !== 'string' || !q.trim() || q.length > 256) ||
    Buffer.byteLength(JSON.stringify(generated)) > 2048
  )
    throw new ValidationFailedError('Recall discovery must return at most eight bounded queries');
  // Longer terms tend to preserve names and task-specific language in verbose requests.
  // The selector still decides relevance; these terms never inject anything themselves.
  const ranked = [...words].sort(
    (a, b) => b.length - a.length || words.indexOf(a) - words.indexOf(b)
  );
  if (ranked.length > 16) reasons.add('discovery_queries_limited');
  const searches = [...new Set([...generated, ...ranked.slice(0, 16)])];
  const pool = new Map<string, { record: MemoryRecord; score: number }>();
  for (const search of searches) {
    const result = await client.retrieve({
      ...query,
      text: search,
      limit: Math.min(50, bound),
      excerptChars: 1,
    });
    if (result.completeness === 'partial' || result.nextCursor !== null)
      reasons.add('discovery_results_limited');
    for (const [index, hit] of result.items.entries()) {
      const previous = pool.get(hit.id);
      const record =
        previous?.record.revision === hit.revision ? previous.record : await client.get(hit.id);
      if (!eligible(record) || record.revision !== hit.revision) {
        reasons.add('records_changed');
        continue;
      }
      pool.set(record.id, { record, score: (previous?.score ?? 0) + 1 / (60 + index + 1) });
    }
  }
  const discovered = [...pool.values()]
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .map((r) => r.record);
  // Reserve eight disclosure slots for recent zero-overlap facts. Neither source can
  // monopolize the budget; older indexed hits are considered before recency fillers.
  const ordered = [
    ...discovered.slice(0, 24),
    ...recent.slice(0, 8),
    ...discovered.slice(24),
    ...recent.slice(8),
  ];
  const unique = [...new Map(ordered.map((r) => [r.id, r])).values()];
  if (unique.length > bound) reasons.add('candidate_limit');
  return {
    records: unique.slice(0, bound),
    terms: [...words, ...generated.flatMap(discoveryTerms)],
  };
}

// Preserve useful text deep in a long record, without disclosing the whole document.
export function passageWindow(content: string, terms: string[], size = 2048): string {
  const points = Array.from(content);
  if (points.length <= size) return content;
  const lower = content.toLowerCase();
  const anchors = terms.map((term) => lower.indexOf(term)).filter((index) => index >= 0);
  const anchor = anchors.length ? Math.min(...anchors) : 0;
  const start = Math.max(
    0,
    Math.min(
      points.length - size,
      Array.from(content.slice(0, anchor)).length - Math.floor(size / 4)
    )
  );
  return points.slice(start, start + size).join('');
}
