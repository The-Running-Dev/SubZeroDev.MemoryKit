// The local service (S8): HTTP API v1 over node:http, local tokens, loopback only. TLS and
// the remote profile arrive in S9.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Grant } from '../access/index.ts';
import { LocalTokenAuthenticator } from '../authn/index.ts';
import { handle, problemResponse, type HttpResponse } from '../http/index.ts';
import {
  ForbiddenError,
  LimitExceededError,
  StoreUnavailableError,
  UnsupportedError,
  ValidationFailedError,
} from '../model/index.ts';
import { openService, type StoreConfig } from '../sdk/index.ts';

export interface ServeOptions {
  store: StoreConfig;
  listen: { host: string; port: number };
  tls?: { certFile: string; keyFile: string };
  auth:
    | { profile: 'local' }
    | { profile: 'remote'; issuer: string; audience: string; ceiling: Grant[] };
  allowedOrigins?: string[];
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
const DRAIN_INTERVAL_MS = 30_000;

const bareHost = (host: string): string =>
  host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;

export function isLoopback(host: string): boolean {
  const bare = bareHost(host);
  return bare === 'localhost' || bare === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

function invalid(field: string, reason: string): ValidationFailedError {
  return new ValidationFailedError(`Invalid ${field}: ${reason}`, { field, reason });
}

function checkOptions(opts: ServeOptions): void {
  const listen = opts?.listen;
  if (typeof listen?.host !== 'string' || listen.host === '') {
    throw invalid('listen.host', 'required');
  }
  if (!Number.isInteger(listen.port) || listen.port < 0 || listen.port > 65535) {
    throw invalid('listen.port', 'invalid');
  }
  if (opts.tls !== undefined || opts.auth?.profile === 'remote') {
    throw new UnsupportedError('TLS and remote authentication are not available yet', {
      capability: 'server.remote',
    });
  }
  if (opts.auth?.profile !== 'local') throw invalid('auth.profile', 'unsupported');
  // Without TLS a token would cross the network in clear, so only loopback is allowed.
  if (!isLoopback(listen.host)) throw invalid('tls', 'required');
  const origins = opts.allowedOrigins;
  if (
    origins !== undefined &&
    (!Array.isArray(origins) || !origins.every((origin) => typeof origin === 'string'))
  ) {
    throw invalid('allowedOrigins', 'not_a_list');
  }
}

function toHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) {
      try {
        headers.append(name, item);
      } catch {
        // A header Fetch cannot hold is not one this service reads.
      }
    }
  }
  return headers;
}

function tooLarge(): LimitExceededError {
  return new LimitExceededError('The request body is too large', {
    field: 'body',
    limit: MAX_BODY_BYTES,
  });
}

// The body as text, refused past the cap. A refused body is drained, not read, and the
// connection is closed after the reply.
function readBody(req: IncomingMessage, res: ServerResponse): Promise<string> {
  return new Promise((resolve, reject) => {
    if (req.destroyed && !req.complete) {
      reject(new StoreUnavailableError('The request was not completed', { reason: 'aborted' }));
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      res.setHeader('connection', 'close');
      req.resume();
      reject(tooLarge());
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        res.setHeader('connection', 'close');
        reject(tooLarge());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('close', () => {
      if (done) return;
      done = true;
      reject(new StoreUnavailableError('The request was not completed', { reason: 'aborted' }));
    });
    req.on('error', () => {
      // 'close' follows and settles the promise.
    });
  });
}

export async function serve(opts: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  checkOptions(opts);
  const opened = await openService(opts.store);
  const { service, tokens } = opened;
  const authenticator = new LocalTokenAuthenticator(tokens);
  const origins = new Set(opts.allowedOrigins ?? []);
  const inFlight = new Set<Promise<void>>();

  async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let response: HttpResponse;
    try {
      const headers = toHeaders(req);
      // A browser page from another origin is refused before its token is looked at.
      const origin = headers.get('origin');
      if (origin !== null && !origins.has(origin)) {
        throw new ForbiddenError('The request origin is not allowed', { reason: 'origin' });
      }
      const principal = await authenticator.authenticate(headers);
      const body = await readBody(req, res);
      response = await handle(service.as(principal), {
        method: req.method ?? 'GET',
        path: (req.url ?? '/').split('?')[0]!,
        headers,
        body,
      });
    } catch (error) {
      response = problemResponse(error);
    }
    if (res.destroyed) return;
    res.writeHead(response.status, {
      ...response.headers,
      'content-length': String(Buffer.byteLength(response.body)),
    });
    res.end(response.body);
  }

  const server = createServer((req, res) => {
    const pending = respond(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending));
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(opts.listen.port, bareHost(opts.listen.host), () => {
        server.off('error', reject);
        resolve();
      });
    });
  } catch (error) {
    await opened.close();
    throw new StoreUnavailableError('The service cannot listen', {
      reason: 'listen_failed',
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  const address = server.address() as AddressInfo;
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  const url = `http://${host}:${address.port}`;

  // Exports that missed their write-time wait are retried in the background.
  const drainTimer = setInterval(() => {
    service.drain().catch(() => {});
  }, DRAIN_INTERVAL_MS);
  drainTimer.unref();

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      clearInterval(drainTimer);
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      await Promise.allSettled([...inFlight]);
      server.closeAllConnections();
      await stopped;
      await opened.close();
    })();
    return closing;
  };
  return { url, close };
}
