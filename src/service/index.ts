import { authorize, permittedPatterns, type Principal } from '../access/index.ts';
import type {
  HistoryPolicy,
  HistoryProvider,
  StorageProvider,
  StoredRow,
} from '../contracts/index.ts';
import {
  DEFAULT_LIMITS,
  IdempotencyMismatchError,
  InternalError,
  NotFoundError,
  canonicalJson,
  newMemoryId,
  sha256Hex,
  validateCreate,
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

export interface MemoryClient {
  create(input: CreateInput, opts?: WriteOptions): Promise<WriteOutcome>;
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
    const { storage, limits, history, defaultHistoryPolicy } = this.service;
    const normalized = validateCreate(input, limits);
    authorize(this.principal, 'write', normalized.namespace);
    const operationId = validateOperationId(opts.operationId) ?? newMemoryId();
    const fingerprint = sha256Hex(canonicalJson({ operation: 'create', input: normalized }));
    const principalId = this.principal.id;

    const { row, seqs } = await storage.write(async (tx) => {
      const prior = await tx.findOperation(principalId, operationId);
      if (prior) {
        if (prior.fingerprint !== fingerprint) {
          throw new IdempotencyMismatchError('The operation id was used for a different request', {
            operationId,
          });
        }
        const existing = await tx.load(prior.memoryId, { patterns: ['*'] });
        if (!existing)
          throw new NotFoundError('The memory no longer exists', { id: prior.memoryId });
        return { row: existing, seqs: prior.seq === null ? [] : [prior.seq] };
      }
      const policy = await tx.namespacePolicy(normalized.namespace, defaultHistoryPolicy);
      const now = new Date().toISOString();
      const created: StoredRow = {
        record: {
          id: newMemoryId(),
          ...normalized,
          state: 'active',
          priorState: null,
          revision: 1,
          actor: principalId,
          createdAt: now,
          updatedAt: now,
        },
      };
      const record = created.record;
      // History export arrives in S3; until a provider exists there is nothing to queue for.
      const outbox =
        history !== null && policy !== 'none'
          ? [
              {
                operationId,
                memoryId: record.id,
                revision: 1,
                operation: 'create' as const,
                actor: principalId,
                at: now,
                namespace: record.namespace,
                policy,
                payload: { ...record, supersededBy: [] },
              },
            ]
          : [];
      const result = await tx.commit(
        {
          rows: [created],
          outbox,
          operation: { principalId, operationId, fingerprint, memoryId: record.id, revision: 1 },
        },
        [{ id: record.id, revision: null }]
      );
      return { row: created, seqs: result.seqs };
    });

    return {
      operationId,
      memory: await this.withDerived(row),
      storage: 'persisted',
      history: seqs.length > 0 ? 'pending' : 'not_required',
      historyRef: null,
      related: [],
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
