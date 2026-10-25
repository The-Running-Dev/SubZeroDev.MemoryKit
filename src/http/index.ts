// HTTP API v1 (20-contract.md): routes a request to a client that is already authorised for
// the caller, and maps errors to problem+json. Transport-free, so the server owns sockets.

import type { HistoryPolicy } from '../contracts/index.ts';
import {
  NotFoundError,
  ValidationFailedError,
  isPlainObject,
  toProblem,
  type SearchQuery,
} from '../model/index.ts';
import type {
  CreateInput,
  MemoryClient,
  PurgeInput,
  SupersedeInput,
  SyncOptions,
  TransitionInput,
  UpdateInput,
  WriteOptions,
  WriteOutcome,
} from '../service/index.ts';

export interface HttpRequest {
  method: string;
  path: string; // without the query string, still percent-encoded
  headers: Headers;
  body: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function json(status: number, value: unknown): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

export function problemResponse(error: unknown): HttpResponse {
  const problem = toProblem(error);
  const headers: Record<string, string> = { 'content-type': 'application/problem+json' };
  if (problem.status === 401) headers['www-authenticate'] = 'Bearer';
  return { status: problem.status, headers, body: JSON.stringify(problem) };
}

// A write whose history has not caught up, whether pending or blocked, is accepted rather
// than done.
function written(status: number, outcome: WriteOutcome): HttpResponse {
  const behind = outcome.history === 'pending' || outcome.history === 'blocked';
  return json(behind ? 202 : status, outcome);
}

function invalidBody(reason: string): ValidationFailedError {
  return new ValidationFailedError(`Invalid body: ${reason}`, { field: 'body', reason });
}

// An empty body is an empty object, so a transition or sync can be sent without one.
function object(body: string): Record<string, unknown> {
  if (body.trim() === '') return {};
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    throw invalidBody('invalid_json');
  }
  if (!isPlainObject(value)) throw invalidBody('not_an_object');
  return value;
}

// Segments are split before decoding, so an encoded slash stays inside its segment.
function segments(path: string): string[] | null {
  if (!path.startsWith('/')) return null;
  try {
    return path.slice(1).split('/').map(decodeURIComponent);
  } catch {
    return null;
  }
}

// Passed through as given: the service rejects anything that is not a positive integer.
function revisionNumber(text: string): number {
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

function writeOptions(headers: Headers): WriteOptions {
  const key = headers.get('idempotency-key');
  return key === null ? {} : { operationId: key };
}

const TRANSITIONS = ['archive', 'restore', 'tombstone'] as const;

async function route(client: MemoryClient, request: HttpRequest): Promise<HttpResponse | null> {
  const { method, body } = request;
  const parts = segments(request.path);
  if (parts === null || parts[0] !== 'v1') return null;
  const [, resource, ...rest] = parts;
  const opts = writeOptions(request.headers);

  if (resource === 'memories') {
    const [id, action, revision] = rest;
    if (id === undefined) {
      if (method === 'POST') {
        return written(201, await client.create(object(body) as unknown as CreateInput, opts));
      }
      return null;
    }
    if (rest.length === 1) {
      if (method === 'GET') return json(200, await client.get(id));
      if (method === 'PUT') {
        const input = { ...object(body), id } as unknown as UpdateInput;
        return written(200, await client.update(input, opts));
      }
      return null;
    }
    if (rest.length === 2 && method === 'POST') {
      const transition = TRANSITIONS.find((name) => name === action);
      if (transition !== undefined) {
        const input = { ...object(body), id } as unknown as TransitionInput;
        return written(200, await client[transition](input, opts));
      }
      if (action === 'supersede') {
        const input = { ...object(body), id } as unknown as SupersedeInput;
        return written(201, await client.supersede(input, opts));
      }
      if (action === 'purge') {
        const input = { ...object(body), id } as unknown as PurgeInput;
        return json(200, await client.purge(input, opts));
      }
      return null;
    }
    if (action === 'history' && method === 'GET') {
      if (rest.length === 2) return json(200, await client.history(id));
      if (rest.length === 3) return json(200, await client.revision(id, revisionNumber(revision!)));
    }
    return null;
  }
  if (resource === 'search' && rest.length === 0 && method === 'POST') {
    return json(200, await client.search(object(body) as SearchQuery));
  }
  if (resource === 'operations' && rest.length === 1 && method === 'GET') {
    return json(200, await client.operation(rest[0]!));
  }
  if (resource === 'status' && rest.length === 0 && method === 'GET') {
    return json(200, await client.status());
  }
  if (resource === 'namespaces' && rest.length === 1) {
    const ns = rest[0]!;
    if (method === 'GET') return json(200, await client.getNamespace(ns));
    if (method === 'PUT') {
      const policy = object(body).historyPolicy as HistoryPolicy;
      return json(200, await client.setNamespacePolicy(ns, policy));
    }
    return null;
  }
  if (resource === 'history' && rest.length === 1 && rest[0] === 'sync' && method === 'POST') {
    return json(200, await client.syncHistory(object(body) as SyncOptions));
  }
  return null;
}

export async function handle(client: MemoryClient, request: HttpRequest): Promise<HttpResponse> {
  try {
    const response = await route(client, request);
    if (response !== null) return response;
    throw new NotFoundError('No such route', { method: request.method });
  } catch (error) {
    return problemResponse(error);
  }
}
