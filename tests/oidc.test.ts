import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { authorize, intersectGrants, parseScopeClaim, type Grant } from '../src/access/index.ts';
import { OidcAuthenticator } from '../src/authn/index.ts';
import {
  AuthenticationUnavailableError,
  ForbiddenError,
  NotFoundError,
  UnauthenticatedError,
  ValidationFailedError,
} from '../src/model/index.ts';
import { connect, initStore, type StoreConfig } from '../src/sdk/index.ts';
import { serve, type ServeOptions } from '../src/server/index.ts';
import { CLI, runCli, tempDir } from './helpers.ts';
import { startIssuer, type TestIssuer } from './oidc-issuer.ts';
import { CERT_FILE, KEY_FILE, trustingFetch } from './tls.ts';

const AUDIENCE = 'memorykit-test';
const TLS = { certFile: CERT_FILE, keyFile: KEY_FILE };
const DEMO: Grant[] = [{ pattern: 'demo/*', permissions: ['read', 'write'] }];
const closers: (() => Promise<void>)[] = [];

async function started(issuer: TestIssuer, ceiling: Grant[] = DEMO) {
  const store: StoreConfig = { path: tempDir(), history: { provider: 'memory' } };
  await initStore(store);
  const server = await serve({
    store,
    listen: { host: '127.0.0.1', port: 0 },
    tls: TLS,
    auth: { profile: 'remote', issuer: issuer.issuer, audience: AUDIENCE, ceiling },
  });
  closers.push(server.close);
  return server.url;
}

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

async function problem(response: Response) {
  assert.equal(response.headers.get('content-type'), 'application/problem+json');
  return (await response.json()) as { code: string; details: Record<string, unknown> };
}

function listening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    child.stdout!.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const match = /Listening on (\S+)/.exec(out);
      if (match) resolve(match[1]!);
    });
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => (err += chunk));
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${err}`)));
  });
}

describe('S9 remote access', () => {
  let issuer: TestIssuer;
  before(async () => {
    issuer = await startIssuer(AUDIENCE);
  });
  // Inside the suite, so the servers close before the helpers remove their directories.
  after(async () => {
    for (const close of closers.reverse()) await close();
    await issuer.close();
  });

  it('S9.1 an issuer token creates and reads over HTTPS', async () => {
    const url = await started(issuer);
    assert.match(url, /^https:\/\//);
    const client = connect(url, { token: issuer.token(), fetch: trustingFetch });
    const outcome = await client.create({ namespace: 'demo/a', kind: 'note', content: 'hello' });
    assert.equal(outcome.memory.revision, 1);
    assert.equal((await client.get(outcome.memory.id)).content, 'hello');
    await assert.rejects(
      client.create({ namespace: 'other', kind: 'note', content: 'x' }),
      ForbiddenError
    );
  });

  it('S9.2 bad tokens get 401; an offline issuer with no cached key gets 503', async () => {
    const url = await started(issuer);
    const status = `${url}/v1/status`;
    const now = Math.floor(Date.now() / 1000);
    const cases: [string, string][] = [
      ['audience', issuer.token({ aud: 'someone-else' })],
      ['issuer', issuer.token({ iss: 'https://issuer.example' })],
      ['expired', issuer.token({ iat: now - 7200, exp: now - 3600 })],
      ['unknown_key', issuer.token({}, { key: 'unknown' })],
      ['malformed', 'not-a-jwt'],
    ];
    for (const [reason, token] of cases) {
      const response = await trustingFetch(status, bearer(token));
      assert.equal(response.status, 401, reason);
      assert.equal(
        response.headers.get('www-authenticate'),
        `Bearer resource_metadata="${url}/.well-known/oauth-protected-resource"`
      );
      const body = await problem(response);
      assert.equal(body.code, 'Unauthenticated');
      assert.equal(body.details.reason, reason);
    }
    assert.equal((await trustingFetch(status)).status, 401);

    // Keys this service already fetched keep working while the issuer is down.
    issuer.setOnline(false);
    try {
      assert.equal((await trustingFetch(status, bearer(issuer.token()))).status, 200);
      const fresh = await started(issuer);
      const response = await trustingFetch(`${fresh}/v1/status`, bearer(issuer.token()));
      assert.equal(response.status, 503);
      const body = await problem(response);
      assert.equal(body.code, 'AuthenticationUnavailable');
    } finally {
      issuer.setOnline(true);
    }
  });

  it('S9.3 the ceiling bounds the scope; unreadable namespaces are NotFound', async () => {
    const authn = new OidcAuthenticator({
      issuer: issuer.issuer,
      audience: AUDIENCE,
      ceiling: DEMO,
    });
    const purger = await authn.authenticate(
      new Headers(bearer(issuer.token({ scope: 'mk:purge:*' })).headers)
    );
    assert.deepEqual(purger.grants, []);
    assert.throws(() => authorize(purger, 'purge', 'demo/a'), ForbiddenError);

    const url = await started(issuer, [{ pattern: '*', permissions: ['read', 'write'] }]);
    const writer = connect(url, {
      token: issuer.token({ scope: 'mk:read:team/* mk:write:team/*' }),
      fetch: trustingFetch,
    });
    const { memory } = await writer.create({ namespace: 'team/b', kind: 'note', content: 'b' });
    const reader = connect(url, {
      token: issuer.token({ scope: 'mk:read:team/a' }),
      fetch: trustingFetch,
    });
    await assert.rejects(reader.get(memory.id), NotFoundError);
  });

  it('S9.4 protected-resource metadata names the issuer and resource', async () => {
    const url = await started(issuer);
    const response = await trustingFetch(`${url}/.well-known/oauth-protected-resource`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      resource: AUDIENCE,
      authorization_servers: [issuer.issuer],
      bearer_methods_supported: ['header'],
    });
  });

  it('serve validates the remote options', async () => {
    const store = { path: tempDir() };
    const remote = (overrides: Partial<ServeOptions>): ServeOptions => ({
      store,
      listen: { host: '127.0.0.1', port: 0 },
      tls: TLS,
      auth: { profile: 'remote', issuer: issuer.issuer, audience: AUDIENCE, ceiling: DEMO },
      ...overrides,
    });
    const reasons: [Partial<ServeOptions>, string, string][] = [
      [{ tls: undefined }, 'tls', 'required'],
      [{ tls: { certFile: `${CERT_FILE}.missing`, keyFile: KEY_FILE } }, 'tls', 'unreadable'],
      [
        {
          auth: {
            profile: 'remote',
            issuer: 'http://issuer.example',
            audience: AUDIENCE,
            ceiling: DEMO,
          },
        },
        'auth.issuer',
        'https_required',
      ],
      [
        { auth: { profile: 'remote', issuer: issuer.issuer, audience: '', ceiling: DEMO } },
        'auth.audience',
        'required',
      ],
    ];
    for (const [overrides, field, reason] of reasons) {
      await assert.rejects(serve(remote(overrides)), (error: unknown) => {
        assert.ok(error instanceof ValidationFailedError);
        assert.deepEqual(error.details, { field, reason });
        return true;
      });
    }
  });

  it('the authenticator checks subject and not-before', async () => {
    const authn = new OidcAuthenticator({
      issuer: issuer.issuer,
      audience: AUDIENCE,
      ceiling: DEMO,
    });
    const headers = (token: string) => new Headers(bearer(token).headers);
    const now = Math.floor(Date.now() / 1000);
    await assert.rejects(authn.authenticate(headers(issuer.token({ sub: undefined }))), {
      code: 'Unauthenticated',
      details: { reason: 'subject' },
    });
    await assert.rejects(authn.authenticate(headers(issuer.token({ nbf: now + 3600 }))), {
      details: { reason: 'not_yet_valid' },
    });
    await assert.rejects(
      authn.authenticate(headers(issuer.sign({ iss: issuer.issuer }, { kid: 'nope' }))),
      UnauthenticatedError
    );
    const principal = await authn.authenticate(headers(issuer.token({ aud: ['x', AUDIENCE] })));
    assert.equal(principal.id, 'remote-app');
    assert.equal(principal.profile, 'remote');
    assert.deepEqual(principal.grants, DEMO);
  });

  it('an offline issuer before the first fetch is AuthenticationUnavailable', async () => {
    const authn = new OidcAuthenticator({
      issuer: issuer.issuer,
      audience: AUDIENCE,
      ceiling: DEMO,
    });
    issuer.setOnline(false);
    try {
      await assert.rejects(
        authn.authenticate(new Headers(bearer(issuer.token()).headers)),
        (error: unknown) => error instanceof AuthenticationUnavailableError && error.retryable
      );
    } finally {
      issuer.setOnline(true);
    }
  });

  it('CLI serve takes the TLS and OIDC flags', async () => {
    const dir = tempDir();
    assert.equal(runCli(['init', dir]).status, 0);
    const partial = runCli(['serve', '--store', dir, '--oidc-issuer', issuer.issuer]);
    assert.equal(partial.status, 2);
    assert.match(partial.stderr, /--oidc-issuer, --oidc-audience and --oidc-ceiling go together/);
    const child = spawn(process.execPath, [
      CLI,
      'serve',
      '--store',
      dir,
      '--listen',
      '127.0.0.1:0',
      '--tls-cert',
      CERT_FILE,
      '--tls-key',
      KEY_FILE,
      '--oidc-issuer',
      issuer.issuer,
      '--oidc-audience',
      AUDIENCE,
      '--oidc-ceiling',
      'read,write:demo/*',
    ]);
    const exited = new Promise((resolve) => child.on('exit', resolve));
    try {
      const url = await listening(child);
      const client = connect(url, { token: issuer.token(), fetch: trustingFetch });
      const { memory } = await client.create({ namespace: 'demo/c', kind: 'note', content: 'c' });
      assert.equal((await client.get(memory.id)).content, 'c');
    } finally {
      child.kill();
      await exited;
    }
  });
});

describe('S9 scope claims', () => {
  it('parseScopeClaim keeps only well-formed mk items', () => {
    assert.deepEqual(
      parseScopeClaim('openid mk:read:demo/* mk:bogus:x mk:write: mk:write:Bad! profile'),
      [{ pattern: 'demo/*', permissions: ['read'] }]
    );
    assert.deepEqual(parseScopeClaim(''), []);
  });

  it('intersectGrants takes the narrower pattern and drops partial overlaps', () => {
    const ceiling: Grant[] = [
      { pattern: 'demo/*', permissions: ['read', 'write'] },
      { pattern: '*', permissions: ['history'] },
    ];
    assert.deepEqual(
      intersectGrants(
        [
          { pattern: '*', permissions: ['read'] },
          { pattern: 'demo/a', permissions: ['write', 'history'] },
          { pattern: 'other', permissions: ['write'] },
          { pattern: '*', permissions: ['purge'] },
        ],
        ceiling
      ),
      [
        { pattern: 'demo/*', permissions: ['read'] },
        { pattern: 'demo/a', permissions: ['write', 'history'] },
      ]
    );
  });
});
