import {
  canonicalJson,
  DEFAULT_LIMITS,
  LimitExceededError,
  NotFoundError,
  sha256Hex,
  ValidationFailedError,
  validateSearch,
  type MemoryRecord,
  type SearchQuery,
} from '../model/index.ts';
import type { MemoryClient } from '../service/index.ts';
import { continuationIdentity } from '../service/continuation.ts';
import { fields, integer, scopes, type Scope } from './index.ts';

export interface BrowseInput extends Scope {
  text?: string;
  kinds?: string[];
  includeCandidates?: boolean;
  limit?: number;
  maxBytes?: number;
  previewChars?: number;
  cursor?: string;
}
export interface BrowseItem {
  id: string;
  revision: number;
  namespace: string;
  key: string | null;
  kind: string;
  state: 'active';
  status: 'accepted' | 'candidate';
  sourceRole: 'user' | 'assistant' | 'tool' | 'system' | null;
  updatedAt: string;
  contentBytes: number;
  preview?: { text: string; truncated: boolean };
}
export interface BrowseResult {
  items: BrowseItem[];
  count: number;
  bytes: number;
  nextCursor: string | null;
  completeness: 'complete' | 'partial';
  reasons: string[];
}

const normalize = (s: string) => s.normalize('NFC').toLowerCase();
// JSON rather than nested base64 keeps the continuation envelope small. Both
// fields are opaque navigation data, never content or credentials.
const encode = (q: string, c: string | null) => JSON.stringify({ v: 1, q, c });
function decode(cursor: unknown, fingerprint: string): string | null {
  if (typeof cursor !== 'string' || cursor.length > 8192)
    throw new ValidationFailedError('Invalid browse cursor');
  try {
    const value: unknown = JSON.parse(cursor);
    fields(value, ['v', 'q', 'c'], ['v', 'q', 'c']);
    if (
      value.v !== 1 ||
      value.q !== fingerprint ||
      (value.c !== null && (typeof value.c !== 'string' || !value.c || value.c.length > 4096))
    )
      throw new Error();
    return value.c as string | null;
  } catch {
    throw new ValidationFailedError('Invalid browse cursor');
  }
}
function envelope(
  items: BrowseItem[],
  nextCursor: string | null,
  reasons: Set<string>
): BrowseResult {
  const result: BrowseResult = {
    items,
    count: items.length,
    bytes: 0,
    nextCursor,
    completeness: reasons.size ? 'partial' : 'complete',
    reasons: [...reasons].sort(),
  };
  // Include the bytes field itself in the exact compact JSON wire size.
  for (;;) {
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes === result.bytes) return result;
    result.bytes = bytes;
  }
}

export async function browse(client: MemoryClient, input: BrowseInput): Promise<BrowseResult> {
  fields(
    input,
    [
      'namespace',
      'sharedNamespaces',
      'text',
      'kinds',
      'includeCandidates',
      'limit',
      'maxBytes',
      'previewChars',
      'cursor',
    ],
    ['namespace']
  );
  const namespaces = scopes(input).sort();
  const limit = integer(input.limit, 'limit', 20, 1, 50);
  const maxBytes = integer(input.maxBytes, 'maxBytes', 8192, 512, 65536);
  const previewChars = integer(input.previewChars, 'previewChars', 0, 0, 256);
  if (input.includeCandidates !== undefined && typeof input.includeCandidates !== 'boolean')
    throw new ValidationFailedError('Invalid includeCandidates');
  // Validate optional filters using the existing service bounds, but do not use
  // global FTS ranking: hidden namespaces must not alter browse page boundaries.
  validateSearch({ namespaces, text: input.text, kinds: input.kinds }, DEFAULT_LIMITS);
  const text = input.text === undefined ? null : normalize(input.text.trim());
  const kinds = input.kinds === undefined ? undefined : [...new Set(input.kinds)].sort();
  const query: SearchQuery = { namespaces, states: ['active'], kinds, limit: 1 };
  const fingerprint = sha256Hex(
    canonicalJson({
      operation: 'browse.v1',
      identity: continuationIdentity(client),
      namespaces,
      text,
      kinds: kinds ?? null,
      includeCandidates: input.includeCandidates === true,
      previewChars,
    })
  );
  let position = input.cursor === undefined ? null : decode(input.cursor, fingerprint);
  const eligible = (r: MemoryRecord) =>
    namespaces.includes(r.namespace) &&
    r.state === 'active' &&
    !r.supersededBy.length &&
    (r.metadata.status === 'accepted' ||
      (input.includeCandidates === true && r.metadata.status === 'candidate')) &&
    (kinds === undefined || kinds.includes(r.kind)) &&
    (text === null || normalize(r.content).includes(text));
  const items: BrowseItem[] = [];
  const reasons = new Set<string>();
  let continuation: string | null = null;
  for (let scanned = 0; scanned < 200; scanned++) {
    const before = position;
    const page = await client.search({ ...query, ...(before === null ? {} : { cursor: before }) });
    if (
      page.items.length > 1 ||
      (page.nextCursor !== null &&
        (typeof page.nextCursor !== 'string' ||
          page.nextCursor.length > 4096 ||
          page.nextCursor === before))
    )
      throw new ValidationFailedError('Invalid browse search page');
    position = page.nextCursor;
    if (page.completeness === 'partial')
      reasons.add('provider_' + (page.partialReason ?? 'partial'));
    const prior = page.items[0];
    let current: MemoryRecord | undefined;
    if (prior && eligible(prior)) {
      try {
        current = await client.get(prior.id);
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      if (
        !current ||
        current.id !== prior.id ||
        current.revision !== prior.revision ||
        !eligible(current)
      ) {
        reasons.add('records_changed');
        current = undefined;
      }
    }
    if (current) {
      const role = current.metadata.sourceRole;
      const item: BrowseItem = {
        id: current.id,
        revision: current.revision,
        namespace: current.namespace,
        key: current.key,
        kind: current.kind,
        state: 'active',
        status: current.metadata.status as BrowseItem['status'],
        sourceRole:
          role === 'user' || role === 'assistant' || role === 'tool' || role === 'system'
            ? role
            : null,
        updatedAt: current.updatedAt,
        contentBytes: Buffer.byteLength(current.content),
      };
      if (previewChars) {
        const chars = Array.from(current.content);
        item.preview = {
          text: chars.slice(0, previewChars).join(''),
          truncated: chars.length > previewChars,
        };
      }
      // Reserve the worst stopping reasons and the continuation after this item.
      // If it cannot fit, resume BEFORE this unconsumed item (including at start).
      const reserved = new Set([...reasons, 'byte_limit', 'item_limit', 'scan_budget']);
      if (
        envelope(
          [...items, item],
          position === null ? null : encode(fingerprint, position),
          reserved
        ).bytes > maxBytes
      ) {
        reasons.add('byte_limit');
        continuation = encode(fingerprint, before);
        break;
      }
      items.push(item);
    }
    continuation = position === null ? null : encode(fingerprint, position);
    if (page.completeness === 'partial' || position === null) break;
    if (items.length === limit) {
      reasons.add('item_limit');
      break;
    }
    if (scanned === 199) reasons.add('scan_budget');
  }
  const result = envelope(items, continuation, reasons);
  if (result.bytes > maxBytes)
    throw new LimitExceededError(
      'Browse continuation exceeds maxBytes; retry with a larger budget'
    );
  return result;
}
