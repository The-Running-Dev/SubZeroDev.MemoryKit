// JWT bearer tokens from an OIDC issuer (S9). Keys come from the issuer's JWKS, found through
// its discovery document, and are cached so a short issuer outage does not deny requests.

import { createPublicKey, constants, verify, type KeyObject } from 'node:crypto';
import {
  intersectGrants,
  parseScopeClaim,
  validatePrincipal,
  type Grant,
  type Principal,
} from '../access/index.ts';
import {
  AuthenticationUnavailableError,
  UnauthenticatedError,
  isPlainObject,
} from '../model/index.ts';
import { bearerToken, type Authenticator } from './index.ts';

export interface OidcOptions {
  issuer: string;
  audience: string;
  ceiling: Grant[];
  clockToleranceSec?: number;
  // How long fetched keys are trusted, and the least time between two refreshes.
  keyTtlMs?: number;
  minRefreshIntervalMs?: number;
  fetch?: typeof fetch;
}

const DEFAULT_CLOCK_TOLERANCE_SEC = 60;
const DEFAULT_KEY_TTL_MS = 10 * 60_000;
const DEFAULT_MIN_REFRESH_MS = 30_000;
const FETCH_TIMEOUT_MS = 5_000;
const MAX_TOKEN_LENGTH = 16 * 1024;

type Algorithm =
  'RS256' | 'RS384' | 'RS512' | 'PS256' | 'PS384' | 'PS512' | 'ES256' | 'ES384' | 'EdDSA';
const KEY_TYPE: Record<Algorithm, string> = {
  RS256: 'RSA',
  RS384: 'RSA',
  RS512: 'RSA',
  PS256: 'RSA',
  PS384: 'RSA',
  PS512: 'RSA',
  ES256: 'EC',
  ES384: 'EC',
  EdDSA: 'OKP',
};

interface CachedKey {
  key: KeyObject;
  kty: string;
  alg?: string;
}

function rejected(reason: string): UnauthenticatedError {
  return new UnauthenticatedError('The token is not valid', { reason });
}

function decodeJson(part: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    throw rejected('malformed');
  }
  if (!isPlainObject(value)) throw rejected('malformed');
  return value;
}

function signatureValid(alg: Algorithm, key: KeyObject, data: Buffer, signature: Buffer): boolean {
  switch (alg) {
    case 'RS256':
    case 'RS384':
    case 'RS512':
      return verify(`sha${alg.slice(2)}`, data, key, signature);
    case 'PS256':
    case 'PS384':
    case 'PS512':
      return verify(
        `sha${alg.slice(2)}`,
        data,
        { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: Number(alg.slice(2)) / 8 },
        signature
      );
    case 'ES256':
    case 'ES384':
      return verify(`sha${alg.slice(2)}`, data, { key, dsaEncoding: 'ieee-p1363' }, signature);
    case 'EdDSA':
      return verify(null, data, key, signature);
  }
}

export class OidcAuthenticator implements Authenticator {
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ceiling: Grant[];
  private readonly toleranceSec: number;
  private readonly keyTtlMs: number;
  private readonly minRefreshMs: number;
  private readonly fetchFn: typeof fetch;
  private keys = new Map<string, CachedKey>();
  private keysExpireAt = 0;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private refreshing: Promise<boolean> | undefined;

  constructor(opts: OidcOptions) {
    this.issuer = opts.issuer;
    this.audience = opts.audience;
    this.ceiling = validatePrincipal({
      id: 'ceiling',
      profile: 'remote',
      grants: opts.ceiling,
    }).grants;
    this.toleranceSec = opts.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
    this.minRefreshMs = opts.minRefreshIntervalMs ?? DEFAULT_MIN_REFRESH_MS;
    // Keys that expire before a refresh is allowed would leave guaranteed outage windows.
    this.keyTtlMs = Math.max(opts.keyTtlMs ?? DEFAULT_KEY_TTL_MS, this.minRefreshMs);
    this.fetchFn = opts.fetch ?? globalThis.fetch;
  }

  async authenticate(headers: Headers): Promise<Principal> {
    const token = bearerToken(headers);
    if (token.length > MAX_TOKEN_LENGTH) throw rejected('malformed');
    const parts = token.split('.');
    if (parts.length !== 3) throw rejected('malformed');
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    const alg = header.alg;
    if (typeof alg !== 'string' || !Object.hasOwn(KEY_TYPE, alg)) {
      throw rejected('unsupported_algorithm');
    }
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const key = await this.keyFor(kid, alg as Algorithm);
    const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii');
    let valid: boolean;
    try {
      valid = signatureValid(
        alg as Algorithm,
        key,
        signed,
        Buffer.from(signaturePart, 'base64url')
      );
    } catch {
      valid = false;
    }
    if (!valid) throw rejected('signature');
    this.checkClaims(claims);

    const scope = typeof claims.scope === 'string' ? claims.scope : '';
    return validatePrincipal({
      id: claims.sub,
      profile: 'remote',
      grants: intersectGrants(parseScopeClaim(scope), this.ceiling),
    });
  }

  private checkClaims(claims: Record<string, unknown>): void {
    if (claims.iss !== this.issuer) throw rejected('issuer');
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.audience)) throw rejected('audience');
    const now = Date.now() / 1000;
    if (typeof claims.exp !== 'number' || now - this.toleranceSec >= claims.exp) {
      throw rejected('expired');
    }
    if (
      claims.nbf !== undefined &&
      (typeof claims.nbf !== 'number' || now + this.toleranceSec < claims.nbf)
    ) {
      throw rejected('not_yet_valid');
    }
    if (typeof claims.sub !== 'string' || claims.sub === '' || claims.sub.length > 256) {
      throw rejected('subject');
    }
  }

  // A key the token names, from the cache while it is fresh. A miss refreshes at most once per
  // interval, so forged kids or an offline issuer do not turn every request into a fetch.
  private async keyFor(kid: string | undefined, alg: Algorithm): Promise<KeyObject> {
    const current = (): KeyObject | undefined =>
      Date.now() < this.keysExpireAt ? this.match(kid, alg) : undefined;
    let found = current();
    if (
      found === undefined &&
      (this.refreshing !== undefined || Date.now() - this.lastAttemptAt >= this.minRefreshMs)
    ) {
      await this.refresh();
      found = current();
    }
    if (found !== undefined) return found;
    if (Date.now() >= this.keysExpireAt) {
      throw new AuthenticationUnavailableError("The issuer's signing keys cannot be obtained", {
        reason: 'jwks_unavailable',
      });
    }
    throw rejected('unknown_key');
  }

  private match(kid: string | undefined, alg: Algorithm): KeyObject | undefined {
    const candidates =
      kid === undefined
        ? [...this.keys.values()]
        : [this.keys.get(kid)].filter((k) => k !== undefined);
    const usable = candidates.filter(
      (entry) => entry.kty === KEY_TYPE[alg] && (entry.alg === undefined || entry.alg === alg)
    );
    // Without a kid the key must be unambiguous.
    return usable.length === 1 ? usable[0]!.key : undefined;
  }

  private refresh(): Promise<boolean> {
    this.refreshing ??= this.load().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async load(): Promise<boolean> {
    this.lastAttemptAt = Date.now();
    try {
      const discovery = await this.getJson(
        `${this.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`
      );
      if (discovery.issuer !== this.issuer || typeof discovery.jwks_uri !== 'string') return false;
      if (!fetchable(discovery.jwks_uri)) return false;
      const jwks = await this.getJson(discovery.jwks_uri);
      if (!Array.isArray(jwks.keys)) return false;
      const keys = new Map<string, CachedKey>();
      jwks.keys.forEach((jwk: unknown, index) => {
        if (!isPlainObject(jwk) || (jwk.use !== undefined && jwk.use !== 'sig')) return;
        try {
          const key = createPublicKey({ key: jwk as never, format: 'jwk' });
          const id = typeof jwk.kid === 'string' ? jwk.kid : `#${index}`;
          keys.set(id, {
            key,
            kty: String(jwk.kty),
            ...(typeof jwk.alg === 'string' ? { alg: jwk.alg } : {}),
          });
        } catch {
          // A key Node cannot import cannot verify anything; skip it.
        }
      });
      // A set with nothing usable is treated as a failed fetch, so the keys in hand stay.
      if (keys.size === 0) return false;
      this.keys = keys;
      this.keysExpireAt = Date.now() + this.keyTtlMs;
      return true;
    } catch {
      return false;
    }
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(url, {
      headers: { accept: 'application/json' },
      // A redirect could move the keys onto plain http, so none are followed.
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const value: unknown = await response.json();
    if (!isPlainObject(value)) throw new Error('not an object');
    return value;
  }
}

// Keys fetched in clear could be swapped, so the key set needs https, or http on this host.
function fetchable(text: string): boolean {
  try {
    const url = new URL(text);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const loopback = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
    return url.protocol === 'https:' || (url.protocol === 'http:' && loopback);
  } catch {
    return false;
  }
}
