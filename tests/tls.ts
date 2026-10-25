// The test certificate (self-signed for localhost, 127.0.0.1 and ::1) and a fetch that trusts
// it, since the built-in fetch takes no CA option.

import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { join } from 'node:path';
import { checkServerIdentity as checkIdentity, type PeerCertificate } from 'node:tls';
import { REPO_ROOT } from './helpers.ts';

export const CERT_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tls', 'cert.pem');
export const KEY_FILE = join(REPO_ROOT, 'tests', 'fixtures', 'tls', 'key.pem');
const CA = readFileSync(CERT_FILE);

export const trustingFetch: typeof fetch = (input, init = {}) =>
  new Promise((resolve, reject) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => (headers[name] = value));
    const body = init.body === undefined || init.body === null ? undefined : String(init.body);
    if (body !== undefined) headers['content-length'] = String(Buffer.byteLength(body));
    // The certificate is checked against the URL's host even when a test sends another Host.
    const checkServerIdentity = (_host: string, cert: PeerCertificate) =>
      checkIdentity(url.hostname.replace(/^\[|\]$/g, ''), cert);
    const options = { method: init.method ?? 'GET', headers, ca: CA, checkServerIdentity };
    const req = request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) responseHeaders.set(name, String(value));
        }
        const status = res.statusCode ?? 500;
        resolve(
          new Response(status === 204 ? null : Buffer.concat(chunks), {
            status,
            headers: responseHeaders,
          })
        );
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
