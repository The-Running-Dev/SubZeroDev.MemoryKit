import { canonicalJson, sha256Hex } from '../model/index.ts';
import type { RecallRequest, RecallSelection, RecallSelector } from './index.ts';

/** Derived, sensitive provider output. Implementations must bound retention and isolate
 * store, authorization, scope and provider configuration in their cache identity. */
export interface RecallCache {
  get(key: string): Promise<unknown[] | null>;
  put(key: string, value: unknown[]): Promise<void>;
}

/** Caches provider calls, never final context. The workflow still discovers current
 * candidates, validates quotes and rechecks current record revisions before output. */
export class CachedRecallSelector implements RecallSelector {
  readonly id: string;
  readonly expand?: (query: string) => Promise<string[]>;
  readonly verify?: (
    request: RecallRequest,
    selections: RecallSelection[]
  ) => Promise<RecallSelection[]>;
  hits = 0;
  misses = 0;
  private readonly selector: RecallSelector;
  private readonly cache: RecallCache;
  constructor(selector: RecallSelector, cache: RecallCache) {
    this.id = selector.id;
    this.selector = selector;
    this.cache = cache;
    if (selector.expand)
      this.expand = (query) => this.call('expand', query, () => selector.expand!(query));
    if (selector.verify)
      this.verify = (request, selections) =>
        this.call('verify', { request, selections }, () => selector.verify!(request, selections));
  }
  async select(request: RecallRequest): Promise<RecallSelection[]> {
    return this.call('select', request, () => this.selector.select(request));
  }
  private async call<T extends unknown[]>(
    task: string,
    input: unknown,
    run: () => Promise<T>
  ): Promise<T> {
    const key = sha256Hex(canonicalJson({ version: 1, provider: this.id, task, input }));
    const cached = await this.cache.get(key);
    if (cached !== null) {
      this.hits++;
      return JSON.parse(JSON.stringify(cached)) as T;
    }
    this.misses++;
    const value = await run();
    // A failed provider call is never persisted. Workflow validation remains authoritative.
    if (Array.isArray(value)) await this.cache.put(key, value);
    return value;
  }
}
