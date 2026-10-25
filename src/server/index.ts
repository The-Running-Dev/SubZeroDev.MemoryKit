// The service: HTTP API v1 over node:http, or node:https with TLS. The local profile takes
// local tokens; the remote profile (S9) takes OIDC bearer tokens and requires TLS.

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Grant } from '../access/index.ts';
import { LocalTokenAuthenticator, type Authenticator } from '../authn/index.ts';
import { OidcAuthenticator } from '../authn/oidc.ts';
import { handle, problemResponse, type HttpResponse } from '../http/index.ts';
import {
  ForbiddenError,
  LimitExceededError,
  StoreUnavailableError,
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
  const tls = opts.tls;
  if (
    tls !== undefined &&
    (typeof tls?.certFile !== 'string' ||
      tls.certFile === '' ||
      typeof tls.keyFile !== 'string' ||
      tls.keyFile === '')
  ) {
    throw invalid('tls', 'invalid');
  }
  const auth = opts.auth;
  if (auth?.profile === 'remote') {
    if (tls === undefined) throw invalid('tls', 'required');
    if (typeof auth.audience !== 'string' || auth.audience === '') {
      throw invalid('auth.audience', 'required');
    }
    if (!Array.isArray(auth.ceiling)) throw invalid('auth.ceiling', 'not_a_list');
    let issuer: URL;
    try {
      issuer = new URL(auth.issuer);
    } catch {
      throw invalid('auth.issuer', 'invalid');
    }
    // Keys fetched in clear could be swapped, so plain http is only for an issuer on this host.
    const local = issuer.protocol === 'http:' && isLoopback(issuer.hostname);
    if (issuer.protocol !== 'https:' && !local) throw invalid('auth.issuer', 'https_required');
  } else if (auth?.profile !== 'local') {
    throw invalid('auth.profile', 'unsupported');
  }
  // Without TLS a token would cross the network in clear, so only loopback is allowed.
  if (tls === undefined && !isLoopback(listen.host)) throw invalid('tls', 'required');
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

function readTls(tls: { certFile: string; keyFile: string }): { cert: Buffer; key: Buffer } {
  try {
    return { cert: readFileSync(tls.certFile), key: readFileSync(tls.keyFile) };
  } catch {
    throw invalid('tls', 'unreadable');
  }
}

const METADATA_PATH = '/.well-known/oauth-protected-resource';

export async function serve(opts: ServeOptions): Promise<{ url: string; close(): Promise<void> }> {
  checkOptions(opts);
  const tls = opts.tls === undefined ? undefined : readTls(opts.tls);
  const remote = opts.auth.profile === 'remote' ? opts.auth : undefined;
  // Built before the store opens, so a bad ceiling fails without side effects.
  const oidc =
    remote === undefined
      ? undefined
      : new OidcAuthenticator({
          issuer: remote.issuer,
          audience: remote.audience,
          ceiling: remote.ceiling,
        });
  const opened = await openService(opts.store);
  const { service, tokens } = opened;
  const authenticator: Authenticator = oidc ?? new LocalTokenAuthenticator(tokens);
  const origins = new Set(opts.allowedOrigins ?? []);
  const inFlight = new Set<Promise<void>>();
  // Set once listening; the metadata and the 401 challenge name it.
  let url = '';

  async function respond(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let response: HttpResponse;
    try {
      const headers = toHeaders(req);
      // A browser page from another origin is refused before its token is looked at.
      const origin = headers.get('origin');
      if (origin !== null && !origins.has(origin)) {
        throw new ForbiddenError('The request origin is not allowed', { reason: 'origin' });
      }
      const path = (req.url ?? '/').split('?')[0]!;
      if (remote !== undefined && path === METADATA_PATH && req.method === 'GET') {
        req.resume();
        send(res, {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            resource: remote.audience,
            authorization_servers: [remote.issuer],
            bearer_methods_supported: ['header'],
          }),
        });
        return;
      }
      const principal = await authenticator.authenticate(headers);
      const body = await readBody(req, res);
      response = await handle(service.as(principal), {
        method: req.method ?? 'GET',
        path,
        headers,
        body,
      });
    } catch (error) {
      response = problemResponse(error);
      if (remote !== undefined && response.status === 401) {
        response.headers['www-authenticate'] = `Bearer resource_metadata="${url}${METADATA_PATH}"`;
      }
    }
    send(res, response);
  }

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    const pending = respond(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
    inFlight.add(pending);
    void pending.finally(() => inFlight.delete(pending));
  };
  const server: Server =
    tls === undefined ? createServer(onRequest) : createTlsServer(tls, onRequest);

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
  url = `${tls === undefined ? 'http' : 'https'}://${host}:${address.port}`;

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

function send(res: ServerResponse, response: HttpResponse): void {
  if (res.destroyed) return;
  res.writeHead(response.status, {
    ...response.headers,
    'content-length': String(Buffer.byteLength(response.body)),
  });
  res.end(response.body);
}
