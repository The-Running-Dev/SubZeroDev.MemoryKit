import type { Problem } from '../../src/model/index.ts';

// A result from one surface: the value it returned, or the problem document it failed with.
export type Result<T> = { ok: true; value: T } | { ok: false; problem: Problem };

// One surface (SDK, CLI, later HTTP and MCP) driven through the same scenarios.
export interface Driver {
  readonly name: string;
  init(store: string): Promise<Result<null>>;
  create(
    store: string,
    input: Record<string, unknown>,
    operationId?: string
  ): Promise<Result<Record<string, unknown>>>;
  update(
    store: string,
    input: Record<string, unknown>,
    operationId?: string
  ): Promise<Result<Record<string, unknown>>>;
  get(store: string, id: string): Promise<Result<Record<string, unknown>>>;
}
