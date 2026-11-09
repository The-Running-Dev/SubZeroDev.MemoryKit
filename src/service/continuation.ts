// Internal workflow cursor identity; no change to MemoryClient or storage contracts.
import { randomUUID } from 'node:crypto';
import type { MemoryClient } from './index.ts';

const identities = new WeakMap<MemoryClient, string>();
export function bindContinuation(client: MemoryClient, identity: string): void {
  identities.set(client, identity);
}
export function continuationIdentity(client: MemoryClient): string {
  let identity = identities.get(client);
  if (!identity) {
    // Third-party clients can browse without a new required method. Their cursors
    // are deliberately usable only with this instance, rather than unbound.
    identity = randomUUID();
    identities.set(client, identity);
  }
  return identity;
}
