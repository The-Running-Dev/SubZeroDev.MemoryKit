import type { Grant } from '../../src/access/index.ts';
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
  transition(
    store: string,
    operation: 'archive' | 'restore' | 'tombstone',
    input: Record<string, unknown>,
    operationId?: string
  ): Promise<Result<Record<string, unknown>>>;
  supersede(
    store: string,
    input: Record<string, unknown>,
    operationId?: string
  ): Promise<Result<Record<string, unknown>>>;
  // MCP has no purge tool, so its drivers leave this out and the scenario skips them.
  purge?(
    store: string,
    input: Record<string, unknown>,
    operationId?: string
  ): Promise<Result<Record<string, unknown>>>;
  get(store: string, id: string): Promise<Result<Record<string, unknown>>>;
  search(store: string, query: Record<string, unknown>): Promise<Result<Record<string, unknown>>>;
  retrieve(store: string, query: Record<string, unknown>): Promise<Result<Record<string, unknown>>>;
  // Retrieves as a caller holding only the grants. MCP over stdio always acts as the embedded
  // principal, so its driver leaves this out and the scenario skips it.
  retrieveAs?(
    store: string,
    grants: Grant[],
    query: Record<string, unknown>
  ): Promise<Result<Record<string, unknown>>>;
  history(store: string, id: string): Promise<Result<unknown>>;
  operation(store: string, operationId: string): Promise<Result<Record<string, unknown>>>;
  status(store: string): Promise<Result<Record<string, unknown>>>;
  getNamespace(store: string, ns: string): Promise<Result<Record<string, unknown>>>;
  setNamespacePolicy(
    store: string,
    ns: string,
    policy: string
  ): Promise<Result<Record<string, unknown>>>;
  // Releases anything the driver keeps open between calls, such as a running service.
  close?(): Promise<void>;
}
