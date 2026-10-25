// A minimal OIDC issuer for tests: discovery, a JWKS endpoint and token signing. It can be
// taken offline and back to exercise key caching.

import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TestIssuer {
  issuer: string;
  sign(claims: Record<string, unknown>, opts?: { key?: 'known' | 'unknown'; kid?: string }): string;
  // Claims a valid token carries; overrides replace or, when undefined, remove them.
  token(overrides?: Record<string, unknown>, opts?: { key?: 'known' | 'unknown' }): string;
  setOnline(online: boolean): void;
  close(): Promise<void>;
}

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function ecKey(): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const kid = randomUUID();
  return {
    kid,
    privateKey,
    jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig' },
  };
}

export async function startIssuer(audience: string): Promise<TestIssuer> {
  const known = ecKey();
  const unknown = ecKey();
  let online = true;
  let issuer = '';
  const server: Server = createServer((req, res) => {
    if (!online) {
      res.writeHead(503).end();
      return;
    }
    const body =
      req.url === '/.well-known/openid-configuration'
        ? { issuer, jwks_uri: `${issuer}/jwks` }
        : req.url === '/jwks'
          ? { keys: [known.jwk] }
          : undefined;
    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const signWith = (
    claims: Record<string, unknown>,
    opts: { key?: 'known' | 'unknown'; kid?: string } = {}
  ) => {
    const key = opts.key === 'unknown' ? unknown : known;
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const data = `${part({ alg: 'ES256', typ: 'JWT', kid: opts.kid ?? key.kid })}.${part(claims)}`;
    const signature = sign('sha256', Buffer.from(data), {
      key: key.privateKey,
      dsaEncoding: 'ieee-p1363',
    });
    return `${data}.${signature.toString('base64url')}`;
  };

  return {
    issuer,
    sign: signWith,
    token(overrides = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      const claims: Record<string, unknown> = {
        iss: issuer,
        aud: audience,
        sub: 'remote-app',
        iat: now,
        exp: now + 300,
        scope: 'openid mk:read:demo/* mk:write:demo/*',
      };
      for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) delete claims[name];
        else claims[name] = value;
      }
      return signWith(claims, opts);
    },
    setOnline(value) {
      online = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
