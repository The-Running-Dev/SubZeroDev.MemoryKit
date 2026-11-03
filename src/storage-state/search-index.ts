// Exact candidate prefilter shared by derived indexes. StateStorage remains responsible
// for authorization, metadata, lifecycle, ranking, cursors and response bounds.
import type { StorageSearch } from '../contracts/index.ts';
import { metadataText, searchTerms } from '../model/index.ts';
import type { RecordRow } from './index.ts';

export interface RowSelection {
  query?: StorageSearch;
  any?: boolean;
  ids?: string[];
  supersededIds?: string[];
}
export const plural = (word: string) => word.endsWith('ies') ? word.slice(0, -3) + 'y'
  : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
export function indexedTerms(row: RecordRow): string[] {
  return [...new Set(words(row.kind + ' ' + row.content + ' ' + metadataText(row.metadata))
    .flatMap((w) => ['e:' + w, 'p:' + plural(w)]))];
}
export function selectionTerms(selection: RowSelection): string[] {
  return [...new Set(searchTerms(selection.query?.text ?? '').flatMap(words)
    .map((w) => selection.any ? 'p:' + plural(w) : 'e:' + w))];
}
// SQL identifiers are fixed by the implementation; all values are bound, including terms.
export function rowPredicate(s: RowSelection, bind: (v: unknown) => string): string {
  if (s.ids) return s.ids.length ? `id IN (${s.ids.map(bind).join(',')})` : '1=0';
  const query = s.query;
  if (!query) return '1=1';
  const scopes = query.patterns.map((p) => p === '*' ? '1=1' : p.endsWith('/*')
    ? `(namespace=${bind(p.slice(0, -2))} OR substr(namespace,1,${bind(p.length - 1)})=${bind(p.slice(0, -1))})`
    : `namespace=${bind(p)}`);
  return `(${scopes.join(' OR ') || '1=0'}) AND state IN (${query.states.map(bind).join(',')})` +
    (query.kinds ? ` AND kind IN (${query.kinds.map(bind).join(',')})` : '');
}
