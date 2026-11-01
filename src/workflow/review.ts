import {
  canonicalJson,
  parseNamespace,
  sha256Hex,
  ValidationFailedError,
  type MemoryRecord,
} from '../model/index.ts';
import type { MemoryClient, WriteOutcome } from '../service/index.ts';

export interface ReviewItem {
  memory: MemoryRecord;
  duplicateIds: string[];
}
const digest = (r: MemoryRecord) =>
  sha256Hex(r.content.normalize('NFC').trim().replace(/\s+/gu, ' '));
export async function reviewQueue(
  client: MemoryClient,
  input: { namespace: string; cursor?: string; limit?: number }
) {
  parseNamespace(input.namespace);
  const page = await client.search({
    namespaces: [input.namespace],
    states: ['active'],
    metadata: { status: 'candidate' },
    limit: input.limit ?? 20,
    ...(input.cursor ? { cursor: input.cursor } : {}),
  });
  // Exact normalized text only. Suggestions are bounded and never merge or accept records.
  const comparison = await client.search({
    namespaces: [input.namespace],
    states: ['active'],
    limit: 100,
  });
  const items: ReviewItem[] = page.items
    .filter((r) => !r.supersededBy.length)
    .map((memory) => ({
      memory,
      duplicateIds: comparison.items
        .filter(
          (r) =>
            r.id !== memory.id &&
            !r.supersededBy.length &&
            ['candidate', 'accepted'].includes(String(r.metadata.status)) &&
            digest(r) === digest(memory)
        )
        .map((r) => r.id),
    }));
  return {
    items,
    nextCursor: page.nextCursor,
    completeness: page.completeness,
    duplicateScanLimited: comparison.nextCursor !== null || comparison.completeness === 'partial',
  };
}
export async function reviewMemory(
  client: MemoryClient,
  input: {
    namespace: string;
    id: string;
    expectedRevision: number;
    action: 'accept' | 'reject' | 'correct' | 'duplicate';
    content?: string;
    duplicateOf?: string;
  }
): Promise<WriteOutcome> {
  parseNamespace(input.namespace);
  const current = await client.get(input.id);
  if (
    current.namespace !== input.namespace ||
    current.state !== 'active' ||
    current.supersededBy.length
  )
    throw new ValidationFailedError('Review requires an active memory in the selected namespace');
  if (!['candidate', 'accepted'].includes(String(current.metadata.status)))
    throw new ValidationFailedError('Only candidate or accepted memories can be reviewed');
  if (input.action === 'correct') {
    if (typeof input.content !== 'string' || !input.content.trim())
      throw new ValidationFailedError('Correction needs nonempty content');
    return client.supersede({
      id: current.id,
      expectedRevision: input.expectedRevision,
      replacement: {
        kind: current.kind,
        content: input.content,
        contentType: 'text/plain',
        metadata: {
          ...current.metadata,
          status: 'accepted',
          statement: 'curated',
          correctionSource: 'reviewer',
          correctedFrom: current.id,
        },
        provenance: current.provenance,
      },
    });
  }
  if (!['accept', 'reject', 'duplicate'].includes(input.action))
    throw new ValidationFailedError('Unknown review action');
  if (input.action === 'duplicate') {
    if (!input.duplicateOf || input.duplicateOf === current.id)
      throw new ValidationFailedError('Choose a different duplicate target');
    const target = await client.get(input.duplicateOf);
    if (
      target.namespace !== current.namespace ||
      target.state !== 'active' ||
      target.supersededBy.length ||
      target.metadata.status !== 'accepted' ||
      digest(target) !== digest(current)
    )
      throw new ValidationFailedError(
        'Duplicate target must be an active accepted record with the same normalized text in this namespace'
      );
  }
  return client.update({
    id: current.id,
    expectedRevision: input.expectedRevision,
    metadata: {
      ...current.metadata,
      status: input.action === 'accept' ? 'accepted' : 'rejected',
      review: canonicalJson({
        action: input.action,
        ...(input.action === 'duplicate' ? { duplicateOf: input.duplicateOf! } : {}),
      }),
    },
  });
}
