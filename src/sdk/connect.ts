// A MemoryClient over HTTP API v1. It throws the same typed errors an embedded client does,
// rebuilt from the service's problem bodies.

import type {
  HistoryPolicy,
  HistoryQueue,
  NamespaceInfo,
  OperationStatus,
  PurgeReport,
  RevisionSnapshot,
  RevisionSummary,
  StoreStatus,
} from '../contracts/index.ts';
import {
  InternalError,
  StoreUnavailableError,
  ValidationFailedError,
  fromProblem,
  validateMemoryId,
  validateOperationId,
  type MemoryId,
  type MemoryRecord,
  type Namespace,
  type SearchQuery,
  type SearchResult,
} from '../model/index.ts';
import type {
  CreateInput,
  MemoryClient,
  PurgeInput,
  PurgeOptions,
  SupersedeInput,
  SyncOptions,
  TransitionInput,
  UpdateInput,
  WriteOptions,
  WriteOutcome,
} from '../service/index.ts';

export interface ConnectOptions {
  token?: string;
  fetch?: typeof fetch;
}

export function connect(url: string, opts: ConnectOptions = {}): MemoryClient {
  let base: URL;
  try {
    base = new URL(url);
  } catch {
    throw new ValidationFailedError('Invalid url: invalid', { field: 'url', reason: 'invalid' });
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new ValidationFailedError('Invalid url: unsupported_scheme', {
      field: 'url',
      reason: 'unsupported_scheme',
    });
  }
  if (base.username !== '' || base.password !== '' || base.search !== '' || base.hash !== '') {
    throw new ValidationFailedError('Invalid url: invalid', { field: 'url', reason: 'invalid' });
  }
  const headers = new Headers({ accept: 'application/json' });
  if (opts.token !== undefined) {
    try {
      headers.set('authorization', `Bearer ${opts.token}`);
    } catch {
      throw new ValidationFailedError('Invalid token: malformed', {
        field: 'token',
        reason: 'malformed',
      });
    }
  }
  return new HttpClient(base.href.replace(/\/+$/, ''), headers, opts.fetch ?? globalThis.fetch);
}

const segment = (value: unknown): string => encodeURIComponent(String(value));

// The id goes in the path, so it is checked here, with the service's own rule.
const idPath = (id: unknown): string => `/v1/memories/${segment(validateMemoryId(id))}`;

class HttpClient implements MemoryClient {
  private readonly base: string;
  private readonly headers: Headers;
  private readonly fetchFn: typeof fetch;

  constructor(base: string, headers: Headers, fetchFn: typeof fetch) {
    this.base = base;
    this.headers = headers;
    this.fetchFn = fetchFn;
  }

  // waitForHistoryMs is not carried: the service applies its own wait.
  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: WriteOptions = {}
  ): Promise<T> {
    const headers = new Headers(this.headers);
    const operationId = validateOperationId(opts?.operationId);
    if (operationId !== undefined) headers.set('idempotency-key', operationId);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const fetchFn = this.fetchFn;
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const response = await fetchFn(this.base + path, { method, headers, body: payload });
      status = response.status;
      ok = response.ok;
      text = await response.text();
    } catch {
      throw new StoreUnavailableError(
        'The service cannot be reached',
        { reason: 'unreachable' },
        true
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new InternalError('The service returned an unexpected response', { status });
    }
    if (!ok) throw fromProblem(parsed, status);
    return parsed as T;
  }

  create(input: CreateInput, opts?: WriteOptions): Promise<WriteOutcome> {
    return this.call('POST', '/v1/memories', input, opts);
  }
  update(input: UpdateInput, opts?: WriteOptions): Promise<WriteOutcome> {
    return this.call('PUT', idPath(input?.id), withoutId(input), opts);
  }
  archive(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome> {
    return this.call('POST', `${idPath(input?.id)}/archive`, withoutId(input), opts);
  }
  restore(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome> {
    return this.call('POST', `${idPath(input?.id)}/restore`, withoutId(input), opts);
  }
  tombstone(input: TransitionInput, opts?: WriteOptions): Promise<WriteOutcome> {
    return this.call('POST', `${idPath(input?.id)}/tombstone`, withoutId(input), opts);
  }
  supersede(input: SupersedeInput, opts?: WriteOptions): Promise<WriteOutcome> {
    return this.call('POST', `${idPath(input?.id)}/supersede`, withoutId(input), opts);
  }
  purge(input: PurgeInput, opts?: PurgeOptions): Promise<PurgeReport> {
    return this.call('POST', `${idPath(input?.id)}/purge`, withoutId(input), opts);
  }
  get(id: MemoryId): Promise<MemoryRecord> {
    return this.call('GET', idPath(id));
  }
  search(query: SearchQuery): Promise<SearchResult> {
    return this.call('POST', '/v1/search', query ?? {});
  }
  history(id: MemoryId): Promise<RevisionSummary[]> {
    return this.call('GET', `${idPath(id)}/history`);
  }
  revision(id: MemoryId, revision: number): Promise<RevisionSnapshot> {
    return this.call('GET', `${idPath(id)}/history/${segment(revision)}`);
  }
  operation(operationId: string): Promise<OperationStatus> {
    return this.call('GET', `/v1/operations/${segment(operationId)}`);
  }
  status(): Promise<StoreStatus> {
    return this.call('GET', '/v1/status');
  }
  getNamespace(ns: Namespace): Promise<NamespaceInfo> {
    return this.call('GET', `/v1/namespaces/${segment(ns)}`);
  }
  setNamespacePolicy(ns: Namespace, policy: HistoryPolicy): Promise<NamespaceInfo> {
    return this.call('PUT', `/v1/namespaces/${segment(ns)}`, { historyPolicy: policy });
  }
  syncHistory(opts: SyncOptions = {}): Promise<HistoryQueue> {
    return this.call('POST', '/v1/history/sync', opts);
  }
}

function withoutId<T extends { id: MemoryId }>(input: T): Omit<T, 'id'> {
  const rest: Partial<T> = { ...input };
  delete rest.id;
  return rest as Omit<T, 'id'>;
}
