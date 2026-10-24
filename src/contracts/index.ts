// Provider interfaces (20-contract.md, contracts). Every value crossing these boundaries is
// plain JSON data (invariant 19).

import type {
  MemoryId,
  MemoryRecord,
  Namespace,
  NamespacePattern,
  Operation,
} from '../model/index.ts';

export type HistoryPolicy = 'full' | 'metadata' | 'none';
export type RedactedRecord = Omit<MemoryRecord, 'content' | 'metadata'> & {
  contentHash: string;
  metadataKeys: string[];
};

export interface ProviderDescriptor {
  id: string;
  version: string;
  contractVersions: number[];
  capabilities: string[];
  limitations: string[];
}

export interface RowScope {
  patterns: NamespacePattern[];
}
export interface StoredRow {
  record: Omit<MemoryRecord, 'supersededBy'>;
}
export interface OutboxEntry {
  seq: number;
  operationId: string;
  memoryId: MemoryId;
  revision: number;
  operation: Operation;
  actor: string;
  at: string;
  namespace: Namespace;
  policy: Exclude<HistoryPolicy, 'none'>;
  payload: MemoryRecord | RedactedRecord | null;
}
// The records an operation returned, kept so a replay returns the same outcome.
export interface StoredOutcome {
  memory: StoredRow['record'];
  related: StoredRow['record'][];
}
export interface WriteBatch {
  rows: StoredRow[];
  outbox: Omit<OutboxEntry, 'seq'>[];
  operation: {
    principalId: string;
    operationId: string;
    fingerprint: string;
    memoryId: MemoryId;
    revision: number;
    outcome: StoredOutcome;
  };
}
export interface StorageTransaction {
  findOperation(
    principalId: string,
    operationId: string
  ): Promise<{
    fingerprint: string;
    memoryId: MemoryId;
    revision: number;
    seq: number | null;
    outcome: StoredOutcome | null; // null for operations recorded by schema 1
  } | null>;
  load(id: MemoryId, scope: RowScope): Promise<StoredRow | null>;
  findByKey(ns: Namespace, key: string): Promise<MemoryId | null>;
  namespacePolicy(ns: Namespace, defaultPolicy: HistoryPolicy): Promise<HistoryPolicy>;
  commit(
    batch: WriteBatch,
    expected: { id: MemoryId; revision: number | null }[]
  ): Promise<{ seqs: number[] }>;
}
export interface StorageProvider {
  readonly descriptor: ProviderDescriptor;
  open(): Promise<void>;
  close(): Promise<void>;
  write<T>(fn: (tx: StorageTransaction) => Promise<T>): Promise<T>;
  get(id: MemoryId, scope: RowScope): Promise<StoredRow | null>;
  supersededBy(ids: MemoryId[]): Promise<Record<MemoryId, MemoryId[]>>;
}

// Placeholder until S3 defines the history provider.
export interface HistoryProvider {
  readonly descriptor: ProviderDescriptor;
  open(): Promise<void>;
  close(): Promise<void>;
}
