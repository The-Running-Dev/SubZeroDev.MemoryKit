import { authorize, permittedPatterns, type Principal } from '../access/index.ts';
import {
  HISTORY_POLICIES,
  type HistoryPolicy,
  type HistoryProvider,
  type HistoryQueue,
  type HistoryStatus,
  type NamespaceInfo,
  type OperationStatus,
  type OutboxEntry,
  type RedactedRecord,
  type RevisionSnapshot,
  type RevisionSummary,
  type StorageProvider,
  type StorageTransaction,
  type StoreStatus,
  type StoredOutcome,
  type StoredRow,
} from '../contracts/index.ts';
import {
  DEFAULT_LIMITS,
  ForbiddenError,
  HistoryNotRetainedError,
  HistoryUnavailableError,
  IdempotencyMismatchError,
  InternalError,
  MemoryKitError,
  NotFoundError,
  RevisionConflictError,
  ValidationFailedError,
  canonicalJson,
  newMemoryId,
  nextState,
  parseNamespace,
  requireContentMatchesType,
  sha256Hex,
  validateCreate,
  validateUpdate,
  validateMemoryId,
  validateOperationId,
  validateRevision,
  validateSupersede,
  validateTransition,
  type ContentType,
  type JsonValue,
  type Limits,
  type Link,
  type MemoryId,
  type MemoryRecord,
  type Namespace,
  type NamespacePattern,
  type NormalizedCreate,
  type Operation,
  type Provenance,
} from '../model/index.ts';

export interface WriteOptions {
  operationId?: string;
  waitForHistoryMs?: number;
}
export type { HistoryStatus } from '../contracts/index.ts';
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

export interface TransitionInput {
  id: MemoryId;
  expectedRevision: number;
  provenance?: Provenance; // replaces the memory's provenance when given
}

export interface SupersedeInput {
  id: MemoryId;
  expectedRevision: number;
  replacement: Omit<CreateInput, 'namespace'> & { namespace?: Namespace }; // defaults to the target's
}

export interface SyncOptions {
  retryBlocked?: boolean;
  budgetMs?: number;
}

export interface MemoryClient {
  create(input: CreateInput, opts?: WriteOptions): Promise<WriteOutcome>;
  update(input: UpdateInput, opts?: WriteOptions): Promise<WriteOutcome>;
  archive(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome>;
  restore(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome>;
  tombstone(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome>;
  supersede(input: SupersedeInput, opts?: WriteOptions): Promise<WriteOutcome>;
  get(id: MemoryId): Promise<MemoryRecord>;
  history(id: MemoryId): Promise<RevisionSummary[]>;
  revision(id: MemoryId, revision: number): Promise<RevisionSnapshot>;
  operation(operationId: string): Promise<OperationStatus>;
  status(): Promise<StoreStatus>;
  getNamespace(ns: Namespace): Promise<NamespaceInfo>;
  setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo>;
  syncHistory(opts?: SyncOptions): Promise<HistoryQueue>;
}

export interface ServiceConfig {
  limits?: Partial<Limits>;
  historyWaitMs?: number;
  operationRetentionDays?: number;
  drainBudgetMs?: number;
  maxExportAttempts?: number;
  defaultHistoryPolicy?: HistoryPolicy; // set by the sdk from StoreConfig
}

const LEASE_TTL_MS = 30_000;
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const DAY_MS = 86_400_000;

// How a drain pass ended. Only idle means the queue is empty.
type PassResult = 'idle' | 'retry' | 'budget' | 'error' | 'held' | 'lost' | 'blocked';

export class MemoryService {
  readonly storage: StorageProvider;
  readonly history: HistoryProvider | null;
  readonly limits: Limits;
  readonly defaultHistoryPolicy: HistoryPolicy;
  readonly historyWaitMs: number;
  readonly drainBudgetMs: number;
  readonly maxExportAttempts: number;
  readonly operationRetentionDays: number;

  private readonly holder = newMemoryId();
  private closed = false;
  private draining: Promise<void> | null = null;
  private again = false;
  private budgetMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = MIN_BACKOFF_MS;
  private retryAt = 0;

  constructor(
    storage: StorageProvider,
    history: HistoryProvider | null,
    config: ServiceConfig = {}
  ) {
    this.storage = storage;
    this.history = history;
    this.limits = { ...DEFAULT_LIMITS, ...config.limits };
    this.defaultHistoryPolicy = config.defaultHistoryPolicy ?? 'full';
    this.historyWaitMs = config.historyWaitMs ?? 5_000;
    this.drainBudgetMs = config.drainBudgetMs ?? 10_000;
    this.maxExportAttempts = config.maxExportAttempts ?? 10;
    this.operationRetentionDays = config.operationRetentionDays ?? 7;
    this.budgetMs = this.drainBudgetMs;
  }

  // Opening drains whatever an earlier process left pending.
  async open(): Promise<void> {
    this.closed = false;
    await this.storage.open();
    try {
      await this.history?.open();
    } catch (error) {
      await this.storage.close();
      throw error;
    }
    const cutoff = new Date(Date.now() - this.operationRetentionDays * DAY_MS).toISOString();
    await this.storage.pruneOperations(cutoff);
    await this.drain();
  }

  // An export in flight finishes first; nothing new starts.
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.draining;
    await this.history?.close();
    await this.storage.close();
  }

  as(principal: Principal): MemoryClient {
    return new ServiceClient(this, principal);
  }

  // Exports pending entries. A call while a pass runs asks for one more pass, so an entry
  // committed during a pass is never left waiting for the timer.
  drain(budgetMs: number = this.drainBudgetMs): Promise<void> {
    if (this.history === null || this.closed) return Promise.resolve();
    this.again = true;
    this.budgetMs = budgetMs;
    this.draining ??= this.loop();
    return this.draining;
  }

  // Starts a drain and waits up to waitMs for it. While a failed export backs off, a write
  // leaves its entry to the timer, so writes alone never use up the attempts.
  async awaitHistory(waitMs: number): Promise<void> {
    if (Date.now() < this.retryAt) return;
    const drained = this.drain();
    if (waitMs === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const elapsed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
    });
    await Promise.race([drained, elapsed]);
    clearTimeout(timer);
  }

  private async loop(): Promise<void> {
    let result: PassResult = 'idle';
    try {
      while (this.again && !this.closed) {
        this.again = false;
        result = await this.pass(this.budgetMs).catch((): PassResult => 'error');
        if (result !== 'idle') break;
      }
    } finally {
      this.draining = null;
    }
    this.schedule(result);
  }

  // Whatever is left pending is retried periodically, with backoff. A blocked queue waits
  // for an operator, and a lost lease means another drainer has taken over.
  private schedule(result: PassResult): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.retryAt = 0;
    if (this.closed || result === 'lost' || result === 'blocked') return;
    if (result === 'idle') {
      this.backoffMs = MIN_BACKOFF_MS;
      return;
    }
    const delay = result === 'budget' ? 0 : this.backoffMs;
    if (result !== 'budget') {
      this.retryAt = Date.now() + delay;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, delay);
    this.timer.unref();
  }

  // One pass under the drain lease, exporting in seq order until the queue is empty, an
  // export fails, or the budget runs out.
  private async pass(budgetMs: number): Promise<PassResult> {
    const { storage } = this;
    let lease: { token: number } | null;
    try {
      lease = await storage.acquireDrainLease(this.holder, LEASE_TTL_MS);
    } catch {
      return 'error';
    }
    if (!lease) return 'held';
    const deadline = Date.now() + budgetMs;
    try {
      for (;;) {
        if (this.closed || Date.now() >= deadline) return 'budget';
        const next = await storage.nextOutbox();
        if (next === null) return 'idle';
        if ('blocked' in next) return 'blocked';
        const { attempts, ...entry } = next;
        const result = await this.export(entry, attempts, lease.token);
        if (result !== null) return result;
      }
    } catch {
      return 'error';
    } finally {
      await storage.releaseDrainLease(lease.token).catch(() => undefined);
    }
  }

  // Exports one entry; null means it was exported and the pass goes on.
  private async export(
    entry: OutboxEntry,
    attempts: number,
    token: number
  ): Promise<PassResult | null> {
    const { storage } = this;
    const after = await storage.lastExportedRef();
    let historyRef: string;
    try {
      ({ historyRef } = await this.history!.record({ ...entry, after }));
    } catch (error) {
      const { retryable, outage, ...cause } = describeFailure(error);
      // An outage, such as a missing executable, keeps entries pending however long it lasts.
      const block = !retryable || (!outage && attempts + 1 >= this.maxExportAttempts);
      if (!(await storage.markFailed(entry.seq, cause, block, token))) return 'lost';
      return block ? 'blocked' : 'retry';
    }
    if (!(await storage.markExported(entry.seq, historyRef, token))) return 'lost';
    return null;
  }
}

// The cause recorded on a failed entry. A reason in the details is more specific than the
// code; an unknown error is retried, and its message is not kept since it may carry values.
function describeFailure(error: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  outage: boolean;
} {
  if (error instanceof MemoryKitError) {
    const reason = error.details.reason;
    return {
      code: typeof reason === 'string' ? reason : error.code,
      message: error.message,
      retryable: error.retryable,
      outage: error.retryable && error.details.outage === true,
    };
  }
  return { code: 'Internal', message: 'Internal error', retryable: true, outage: false };
}

// What history keeps of a revision under the namespace's policy.
function retained(
  record: MemoryRecord,
  policy: Exclude<HistoryPolicy, 'none'>
): MemoryRecord | RedactedRecord {
  if (policy === 'full') return record;
  const { content, metadata, ...rest } = record;
  return { ...rest, contentHash: sha256Hex(content), metadataKeys: Object.keys(metadata).sort() };
}

// A revision to write, with the revision storage must still hold (null for a new memory).
interface Write {
  record: StoredRow['record'];
  expected: number | null;
}

// The supersededBy a record will have once the batch commits: the batch's own records
// replace whatever links they had before.
function batchSupersededBy(id: MemoryId, stored: MemoryId[], writes: Write[]): MemoryId[] {
  const batch = new Set(writes.map((write) => write.record.id));
  const sources = stored.filter((source) => !batch.has(source));
  for (const { record } of writes) {
    if (record.links.some((link) => link.type === 'supersedes' && link.target === id)) {
      sources.push(record.id);
    }
  }
  return sources.sort();
}

function validateDuration(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ValidationFailedError(`Invalid ${field}: not_a_duration`, {
      field,
      reason: 'not_a_duration',
    });
  }
  return value;
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
    const patterns = permittedPatterns(this.principal, 'write');
    return this.mutate('create', normalized, opts, patterns, async (_tx, now) => [
      { record: this.created(normalized, now), expected: null },
    ]);
  }

  async update(input: UpdateInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    const normalized = validateUpdate(input, this.service.limits);
    const patterns = permittedPatterns(this.principal, 'write');
    return this.mutate('update', normalized, opts, patterns, async (tx, now) => {
      const before = await this.loadExpected(tx, normalized, patterns);
      const record: StoredRow['record'] = {
        ...before,
        ...normalized.changes,
        state: nextState('update', before.state, before.priorState),
        revision: before.revision + 1,
        actor: this.principal.id,
        updatedAt: now,
      };
      requireContentMatchesType(record.content, record.contentType);
      return [{ record, expected: before.revision }];
    });
  }

  archive(input: TransitionInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    return this.transition('archive', input, opts);
  }

  restore(input: TransitionInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    return this.transition('restore', input, opts);
  }

  tombstone(input: TransitionInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    return this.transition('tombstone', input, opts);
  }

  // The replacement and the superseded target are written in one transaction; the outcome is
  // the replacement, with the target in related.
  async supersede(input: SupersedeInput, opts: WriteOptions = {}): Promise<WriteOutcome> {
    const normalized = validateSupersede(input, this.service.limits);
    const { replacement } = normalized;
    if (replacement.namespace !== null) authorize(this.principal, 'write', replacement.namespace);
    const patterns = permittedPatterns(this.principal, 'write');
    return this.mutate('supersede', normalized, opts, patterns, async (tx, now) => {
      const before = await this.loadExpected(tx, normalized, patterns);
      const target: StoredRow['record'] = {
        ...before,
        state: nextState('supersede', before.state, before.priorState),
        revision: before.revision + 1,
        actor: this.principal.id,
        updatedAt: now,
      };
      const created = this.created(
        { ...replacement, namespace: replacement.namespace ?? before.namespace },
        now
      );
      return [
        { record: created, expected: null },
        { record: target, expected: before.revision },
      ];
    });
  }

  // Tombstoning, and restoring a tombstoned memory, need tombstone; the rest need write.
  private async transition(
    op: 'archive' | 'restore' | 'tombstone',
    input: TransitionInput,
    opts: WriteOptions
  ): Promise<WriteOutcome> {
    const normalized = validateTransition(input, this.service.limits);
    // Visible to a writer or a tombstoner; a visible id without the permission is Forbidden.
    const patterns = [
      ...permittedPatterns(this.principal, 'write'),
      ...permittedPatterns(this.principal, 'tombstone'),
    ];
    return this.mutate(op, normalized, opts, patterns, async (tx, now) => {
      const before = await this.loadExpected(tx, normalized, patterns);
      const needed =
        op === 'tombstone' || (op === 'restore' && before.state === 'tombstoned')
          ? 'tombstone'
          : 'write';
      authorize(this.principal, needed, before.namespace);
      const record: StoredRow['record'] = {
        ...before,
        state: nextState(op, before.state, before.priorState),
        priorState: op === 'tombstone' ? before.state : null,
        revision: before.revision + 1,
        actor: this.principal.id,
        updatedAt: now,
      };
      if (normalized.provenance !== undefined) record.provenance = normalized.provenance;
      return [{ record, expected: before.revision }];
    });
  }

  private created(fields: NormalizedCreate, now: string): StoredRow['record'] {
    return {
      id: newMemoryId(),
      ...fields,
      state: nextState('create', null, null),
      priorState: null,
      revision: 1,
      actor: this.principal.id,
      createdAt: now,
      updatedAt: now,
    };
  }

  // The current row, visible under the patterns and still at the expected revision.
  private async loadExpected(
    tx: StorageTransaction,
    { id, expectedRevision }: { id: MemoryId; expectedRevision: number },
    patterns: NamespacePattern[]
  ): Promise<StoredRow['record']> {
    const current = await tx.load(id, { patterns });
    if (!current) throw new NotFoundError('Memory not found', { id });
    if (current.record.revision !== expectedRevision) {
      throw new RevisionConflictError('The memory has changed since it was read', {
        id,
        currentRevision: current.record.revision,
      });
    }
    return current.record;
  }

  private policy(tx: StorageTransaction, namespace: Namespace): Promise<HistoryPolicy> {
    return tx.namespacePolicy(namespace, this.service.defaultHistoryPolicy);
  }

  // One write transaction: replay or refuse a known operation id, otherwise build the new
  // revisions, queue their history and record the operation with its outcome. The first
  // write is the outcome's memory and the rest are related. History is then given up to
  // waitForHistoryMs to export before the outcome reports its status.
  private async mutate(
    operation: Operation,
    normalized: unknown,
    opts: WriteOptions,
    replayPatterns: NamespacePattern[],
    build: (tx: StorageTransaction, now: string) => Promise<Write[]>
  ): Promise<WriteOutcome> {
    const { storage, history } = this.service;
    const operationId = validateOperationId(opts.operationId) ?? newMemoryId();
    const waitMs =
      opts.waitForHistoryMs === undefined
        ? this.service.historyWaitMs
        : validateDuration(opts.waitForHistoryMs, 'waitForHistoryMs');
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
        const existing = await tx.load(prior.memoryId, { patterns: replayPatterns });
        if (!existing) throw new NotFoundError('Memory not found', { id: prior.memoryId });
        const seqs = prior.seq === null ? [] : [prior.seq];
        if (prior.outcome) return { outcome: prior.outcome, seqs };
        // Recorded before schema 2 kept outcomes: the current row is the best answer left.
        return { outcome: { memory: existing.record, related: [] }, seqs };
      }
      const now = new Date().toISOString();
      const writes = await build(tx, now);
      const [first, ...rest] = writes.map((write) => write.record);
      if (!first) throw new InternalError('A write produced no revision', { operation });
      const stored = await tx.supersededBy(writes.map((write) => write.record.id));
      // Without a provider, or under policy none, there is nothing to queue for. The policy
      // is still looked up, since that records the namespace.
      const outbox: Omit<OutboxEntry, 'seq'>[] = [];
      for (const { record } of writes) {
        const policy = await this.policy(tx, record.namespace);
        if (history === null || policy === 'none') continue;
        const supersededBy = batchSupersededBy(record.id, stored[record.id] ?? [], writes);
        outbox.push({
          operationId,
          memoryId: record.id,
          revision: record.revision,
          operation,
          actor: principalId,
          at: now,
          namespace: record.namespace,
          policy,
          payload: retained({ ...record, supersededBy }, policy),
        });
      }
      const outcome: StoredOutcome = { memory: first, related: rest };
      const result = await tx.commit(
        {
          rows: writes.map(({ record }) => ({ record })),
          outbox,
          operation: {
            principalId,
            operationId,
            fingerprint,
            memoryId: first.id,
            revision: first.revision,
            outcome,
          },
        },
        writes.map(({ record, expected }) => ({ id: record.id, revision: expected }))
      );
      return { outcome, seqs: result.seqs };
    });

    let historyStatus: HistoryStatus = 'not_required';
    let historyRef: string | null = null;
    if (seqs.length > 0) {
      await this.service.awaitHistory(waitMs);
      const status = await storage.operation(principalId, operationId);
      historyStatus = status?.history ?? 'pending';
      historyRef = status?.historyRef ?? null;
    }
    return {
      operationId,
      memory: await this.withDerived({ record: outcome.memory }),
      storage: 'persisted',
      history: historyStatus,
      historyRef,
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

  async history(id: MemoryId): Promise<RevisionSummary[]> {
    const { row, history } = await this.retainedHistory(id);
    return this.fromProvider(history, () => history.list(id, row.record.namespace));
  }

  async revision(id: MemoryId, revision: number): Promise<RevisionSnapshot> {
    validateMemoryId(id);
    validateRevision(revision, 'revision');
    const { row, history } = await this.retainedHistory(id);
    const found = await this.fromProvider(history, () =>
      history.get(id, row.record.namespace, revision)
    );
    if (!found) throw new NotFoundError('Revision not found', { id, revision });
    return found;
  }

  // The caller's own operations only.
  async operation(operationId: string): Promise<OperationStatus> {
    const id = validateOperationId(operationId);
    if (id === undefined) {
      throw new ValidationFailedError('Invalid operationId: required', {
        field: 'operationId',
        reason: 'required',
      });
    }
    const status = await this.service.storage.operation(this.principal.id, id);
    if (!status) throw new NotFoundError('Operation not found', { operationId: id });
    return status;
  }

  async status(): Promise<StoreStatus> {
    if (permittedPatterns(this.principal, 'read').length === 0) {
      throw new ForbiddenError('The namespace or permission is not granted', {
        permission: 'read',
      });
    }
    const { storage, history } = this.service;
    return {
      contractVersion: 1,
      storage: storage.descriptor,
      history: history?.descriptor ?? null,
      historyQueue: await storage.queue(),
    };
  }

  // A namespace with no stored policy reports the one it would get.
  async getNamespace(ns: Namespace): Promise<NamespaceInfo> {
    const name = parseNamespace(ns);
    authorize(this.principal, 'read', name);
    return (
      (await this.service.storage.getNamespace(name)) ?? {
        name,
        historyPolicy: this.service.defaultHistoryPolicy,
      }
    );
  }

  async setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo> {
    const name = parseNamespace(ns);
    if (!HISTORY_POLICIES.includes(policy)) {
      throw new ValidationFailedError('Invalid historyPolicy: unsupported', {
        field: 'historyPolicy',
        reason: 'unsupported',
      });
    }
    authorize(this.principal, 'admin', name);
    return this.service.storage.setNamespacePolicy(name, policy);
  }

  // Store-wide, so it needs admin on every namespace.
  async syncHistory(opts: SyncOptions = {}): Promise<HistoryQueue> {
    if (!permittedPatterns(this.principal, 'admin').includes('*')) {
      throw new ForbiddenError('The namespace or permission is not granted', {
        permission: 'admin',
      });
    }
    const budgetMs =
      opts.budgetMs === undefined
        ? this.service.drainBudgetMs
        : validateDuration(opts.budgetMs, 'budgetMs');
    const { storage } = this.service;
    if (opts.retryBlocked === true) await storage.unblock();
    await this.service.drain(budgetMs);
    return storage.queue();
  }

  private async retainedHistory(
    id: MemoryId
  ): Promise<{ row: StoredRow; history: HistoryProvider }> {
    validateMemoryId(id);
    const { storage, history } = this.service;
    const row = await storage.get(id, { patterns: permittedPatterns(this.principal, 'history') });
    if (!row) throw new NotFoundError('Memory not found', { id });
    const policy =
      (await storage.getNamespace(row.record.namespace))?.historyPolicy ??
      this.service.defaultHistoryPolicy;
    if (history === null || policy === 'none') {
      throw new HistoryNotRetainedError('History is not retained for this memory', { id });
    }
    return { row, history };
  }

  private async fromProvider<T>(history: HistoryProvider, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      throw new HistoryUnavailableError('History cannot be read', {
        provider: history.descriptor.id,
      });
    }
  }

  private async withDerived(row: StoredRow): Promise<MemoryRecord> {
    const map = await this.service.storage.supersededBy([row.record.id]);
    const supersededBy = map[row.record.id];
    if (!supersededBy) throw new InternalError('Derived links are missing', { id: row.record.id });
    return { ...row.record, supersededBy };
  }
}
