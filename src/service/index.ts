import { authorize, permittedPatterns, type Principal } from '../access/index.ts';
import type {
  HistoryPolicy,
  HistoryProvider,
  StorageProvider,
  StorageTransaction,
  StoredOutcome,
  StoredRow,
} from '../contracts/index.ts';
import {
  DEFAULT_LIMITS,
  IdempotencyMismatchError,
  InternalError,
  NotFoundError,
  RevisionConflictError,
  canonicalJson,
  newMemoryId,
  nextState,
  requireContentMatchesType,
  sha256Hex,
  validateCreate,
  validateUpdate,
  validateMemoryId,
  validateOperationId,
  type ContentType,
  type JsonValue,
  type Limits,
  type Link,
  type MemoryId,
  type MemoryRecord,
  type Namespace,
  type Provenance,
} from '../model/index.ts';

export interface WriteOptions {
  operationId?: string;
  waitForHistoryMs?: number;
}
export type HistoryStatus = 'persisted' | 'pending' | 'blocked' | 'not_required';
export interface WriteOutcome {
  operationId: string;
  memory: MemoryRecord;
  storage: 'persisted';
  history: HistoryStatus;
  historyRef: string | null;
  related: MemoryRecord[];
}

export interface CreateInput {
  namespace: Namespace;
  key?: string;
  kind: string;
  content: string;
  contentType?: ContentType;
  metadata?: Record<string, JsonValue>;
  links?: Link[];
  provenance?: Provenance;
}

export interface UpdateInput {
  id: MemoryId;
  expectedRevision: number;
  kind?: string;
  content?: string;
  contentType?: ContentType;
  metadata?: Record<string, JsonValue>;
  links?: Link[];
  provenance?: Provenance; // omitted fields keep their value; links and metadata are replaced whole
}

export interface MemoryClient {
  create(input: CreateInput, opts?: WriteOptions): Promise<WriteOutcome>;
  update(input: UpdateInput, opts?: WriteOptions): Promise<WriteOutcome>;
  get(id: MemoryId): Promise<MemoryRecord>;
}

export interface ServiceConfig {
  limits?: Partial<Limits>;
  historyWaitMs?: number;
  operationRetentionDays?: number;
  drainBudgetMs?: number;
  maxExportAttempts?: number;
  defaultHistoryPolicy?: HistoryPolicy; // set by the sdk from StoreConfig
}

export class MemoryService {
  readonly storage: StorageProvider;
  readonly history: HistoryProvider | null;
  readonly limits: Limits;
  readonly defaultHistoryPolicy: HistoryPolicy;

  constructor(
    storage: StorageProvider,
    history: HistoryProvider | null,
    config: ServiceConfig = {}
  ) {
    this.storage = storage;
    this.history = history;
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.defaultHistoryPolicy = config.defaultHistoryPolicy ?? 'full';
  }

  async open(): Promise<void> {
    await this.storage.open();
    await this.history?.open();
  }

  async close(): Promise<void> {
    await this.history?.close();
    await this.storage.close();
  }

  as(principal: Principal): MemoryClient {
    return new ServiceClient(this, principal);
  }
}

class ServiceClient implements MemoryClient {
  private readonly service: MemoryService;
  private readonly principal: Principal;

  constructor(service: MemoryService, principal: Principal) {
    this.service = service;
    this.principal = principal;
  }

  async create(input: CreateInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    const normalized = validateCreate(input, this.service.limits);
    authorize(this.principal, 'write', normalized.namespace);
    return this.mutate('create', normalized, opts, async (tx, now) => {
      const record: StoredRow['record'] = {
        id: newMemoryId(),
        ...normalized,
        state: nextState('create', null, null),
        priorState: null,
        revision: 1,
        actor: this.principal.id,
        createdAt: now,
        updatedAt: now,
      };
      return { record, expected: null, policy: await this.policy(tx, record.namespace) };
    });
  }

  async update(input: UpdateInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    const normalized = validateUpdate(input, this.service.limits);
    const scope = { patterns: permittedPatterns(this.principal, 'write') };
    return this.mutate('update', normalized, opts, async (tx, now) => {
      const current = await tx.load(normalized.id, scope);
      if (!current) throw new NotFoundError('Memory not found', { id: normalized.id });
      const before = current.record;
      if (before.revision !== normalized.expectedRevision) {
        throw new RevisionConflictError('The memory has changed since it was read', {
          id: before.id,
          currentRevision: before.revision,
        });
      }
      const record: StoredRow['record'] = {
        ...before,
        ...normalized.changes,
        state: nextState('update', before.state, before.priorState),
        revision: before.revision + 1,
        actor: this.principal.id,
        updatedAt: now,
      };
      requireContentMatchesType(record.content, record.contentType);
      return { record, expected: before.revision, policy: await this.policy(tx, record.namespace) };
    });
  }

  private policy(tx: StorageTransaction, namespace: Namespace): Promise<HistoryPolicy> {
    return tx.namespacePolicy(namespace, this.service.defaultHistoryPolicy);
  }

  // One write transaction: replay or refuse a known operation id, otherwise build the new
  // revision, queue its history and record the operation with its outcome.
  private async mutate(
    operation: 'create' | 'update',
    normalized: unknown,
    opts: WriteOptions,
    build: (
      tx: StorageTransaction,
      now: string
    ) => Promise<{ record: StoredRow['record']; expected: number | null; policy: HistoryPolicy }>
  ): Promise<WriteOutcome> {
    const { storage, history } = this.service;
    const operationId = validateOperationId(opts.operationId) ?? newMemoryId();
    const fingerprint = sha256Hex(canonicalJson({ operation, input: normalized }));
    const principalId = this.principal.id;

    const { outcome, seqs } = await storage.write(async (tx) => {
      const prior = await tx.findOperation(principalId, operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new IdempotencyMismatchError('The operation id was used for a different request', {
            operationId,
          });
        }
        // Grants may have changed since the first attempt; a replay never returns what the
        // caller could not write now.
        const existing = await tx.load(prior.memoryId, {
          patterns: permittedPatterns(this.principal, 'write'),
        });
        if (!existing) throw new NotFoundError('Memory not found', { id: prior.memoryId });
        const seqs = prior.seq === null ? [] : [prior.seq];
        if (prior.outcome) return { outcome: prior.outcome, seqs };
        // Recorded before schema 2 kept outcomes: the current row is the best answer left.
        return { outcome: { memory: existing.record, related: [] }, seqs };
      }
      const now = new Date().toISOString();
      const { record, expected, policy } = await build(tx, now);
      // History export arrives in S3; until a provider exists there is nothing to queue for.
      const outbox =
        history !== null && policy !== 'none'
          ? [
              {
                operationId,
                memoryId: record.id,
                revision: record.revision,
                operation,
                actor: principalId,
                at: now,
                namespace: record.namespace,
                policy,
                payload: { ...record, supersededBy: [] },
              },
            ]
          : [];
      const outcome: StoredOutcome = { memory: record, related: [] };
      const result = await tx.commit(
        {
          rows: [{ record }],
          outbox,
          operation: {
            principalId,
            operationId,
            fingerprint,
            memoryId: record.id,
            revision: record.revision,
            outcome,
          },
        },
        [{ id: record.id, revision: expected }]
      );
      return { outcome, seqs: result.seqs };
    });

    return {
      operationId,
      memory: await this.withDerived({ record: outcome.memory }),
      storage: 'persisted',
      history: seqs.length > 0 ? 'pending' : 'not_required',
      historyRef: null,
      related: await Promise.all(outcome.related.map((record) => this.withDerived({ record }))),
    };
  }

  async get(id: MemoryId): Promise<MemoryRecord> {
    validateMemoryId(id);
    const row = await this.service.storage.get(id, {
      patterns: permittedPatterns(this.principal, 'read'),
    });
    if (!row) throw new NotFoundError('Memory not found', { id });
    return this.withDerived(row);
  }

  private async withDerived(row: StoredRow): Promise<MemoryRecord> {
    const map = await this.service.storage.supersededBy([row.record.id]);
    const supersededBy = map[row.record.id];
    if (!supersededBy) throw new InternalError('Derived links are missing', { id: row.record.id });
    return { ...row.record, supersededBy };
  }
}
