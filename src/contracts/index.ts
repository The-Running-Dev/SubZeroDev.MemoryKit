// Provider interfaces (20-contract.md, contracts). Every value crossing these boundaries is
// plain JSON data (invariant 19).

import {
  MemoryKitError,
  type ErrorDetails,
  type MemoryId,
  type MemoryRecord,
  type Namespace,
  type NamespacePattern,
  type Operation,
} from '../model/index.ts';

export type HistoryPolicy = 'full' | 'metadata' | 'none';
export const HISTORY_POLICIES: readonly HistoryPolicy[] = ['full', 'metadata', 'none'];
export type HistoryStatus = 'persisted' | 'pending' | 'blocked' | 'not_required';
export type RedactedRecord = Omit<MemoryRecord, 'content' | 'metadata'> & {
  contentHash: string;
  metadataKeys: string[];
};

export type BoundaryResult =
  'removed' | 'retained' | 'not_modified' | 'outside_control' | 'unsupported' | 'failed';

export interface RevisionSummary {
  revision: number;
  operation: Operation;
  operationId: string;
  actor: string;
  at: string;
  historyRef: string;
}
export interface RevisionSnapshot extends RevisionSummary {
  record: MemoryRecord | RedactedRecord;
}
export interface OperationStatus {
  operationId: string;
  memoryId: MemoryId;
  revision: number;
  storage: 'persisted';
  history: HistoryStatus;
  historyRef: string | null;
}
export interface HistoryQueue {
  pending: number;
  blocked: { seq: number; operationId: string; error: string } | null;
}
export interface StoreStatus {
  contractVersion: 1;
  storage: ProviderDescriptor;
  history: ProviderDescriptor | null;
  historyQueue: HistoryQueue;
}
export interface NamespaceInfo {
  name: Namespace;
  historyPolicy: HistoryPolicy;
}

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
  supersededBy(ids: MemoryId[]): Promise<Record<MemoryId, MemoryId[]>>;
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
  operation(principalId: string, operationId: string): Promise<OperationStatus | null>;
  pruneOperations(before: string): Promise<number>; // removes operations created before the time
  setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo>;
  getNamespace(ns: Namespace): Promise<NamespaceInfo | null>;
  // outbox
  acquireDrainLease(holder: string, ttlMs: number): Promise<{ token: number } | null>;
  releaseDrainLease(leaseToken: number): Promise<void>;
  nextOutbox(): Promise<
    (OutboxEntry & { attempts: number }) | { blocked: OutboxEntry; error: string } | null
  >;
  lastExportedRef(): Promise<string | null>;
  markExported(seq: number, historyRef: string, leaseToken: number): Promise<boolean>; // false: lease lost
  markFailed(
    seq: number,
    error: { code: string; message: string },
    block: boolean,
    leaseToken: number
  ): Promise<boolean>;
  unblock(): Promise<number>;
  queue(): Promise<HistoryQueue>;
}

export interface HistoryEntry extends OutboxEntry {
  after: string | null; // historyRef of the previously exported entry
}
export interface HistoryProvider {
  readonly descriptor: ProviderDescriptor;
  open(): Promise<void>;
  close(): Promise<void>;
  record(entry: HistoryEntry): Promise<{ historyRef: string }>; // idempotent by operation, memory and revision
  list(memoryId: MemoryId, ns: Namespace): Promise<RevisionSummary[]>;
  get(memoryId: MemoryId, ns: Namespace, revision: number): Promise<RevisionSnapshot | null>;
  purgeCoverage(): Record<
    'history_current_tree' | 'history_past_revisions' | 'history_remotes',
    BoundaryResult
  >;
}

// A history provider's failure. The drainer retries a retryable one and blocks the entry on
// any other; a reason in the details names the cause in status.
export class HistoryProviderError extends MemoryKitError {
  readonly code = 'HistoryUnavailable' as const;
  constructor(message: string, retryable: boolean, details: ErrorDetails = {}) {
    super(message, details, retryable);
  }
}
