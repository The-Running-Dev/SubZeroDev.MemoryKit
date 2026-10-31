import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import { inspectArchive } from '../scripts/check-archive.ts';
import { REGISTRY, requireUnpublished, verifyRelease } from '../scripts/verify-release.ts';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const approved = {
  publish: true,
  tag: `v${manifest.version}`,
  approvedName: manifest.name,
  approvedRegistry: REGISTRY,
};
const publishable = { ...manifest, private: false };

describe('publication guards', () => {
  it('validates the private candidate but refuses publication until explicitly enabled', () => {
    verifyRelease(manifest, { publish: false, tag: `v${manifest.version}` });
    assert.throws(
      () => verifyRelease({ ...manifest, private: true }, approved),
      /publication disabled/
    );
    verifyRelease(publishable, approved);
  });

  it('rejects a mismatched tag, unapproved name, destination or visibility', () => {
    assert.throws(
      () => verifyRelease(publishable, { ...approved, tag: 'v9.9.9' }),
      /tag must match/
    );
    assert.throws(
      () => verifyRelease(publishable, { ...approved, approvedName: '' }),
      /approved package/
    );
    assert.throws(
      () => verifyRelease(publishable, { ...approved, approvedRegistry: '' }),
      /approved registry/
    );
    assert.throws(
      () =>
        verifyRelease(
          {
            ...publishable,
            publishConfig: { registry: 'https://npm.pkg.github.com', access: 'public' },
          },
          approved
        ),
      /npmjs destination/
    );
    assert.throws(
      () =>
        verifyRelease(
          { ...publishable, publishConfig: { registry: REGISTRY, access: 'restricted' } },
          approved
        ),
      /must be public/
    );
  });

  it('accepts registry absence; refuses existing versions and unknown registry state', async () => {
    const request = (status: number, body: unknown): typeof fetch =>
      (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    await requireUnpublished(manifest.name, manifest.version, request(404, {}));
    await requireUnpublished(
      manifest.name,
      manifest.version,
      request(200, { name: manifest.name, versions: { '0.0.1': {} } })
    );
    await assert.rejects(
      requireUnpublished(
        manifest.name,
        manifest.version,
        request(200, { name: manifest.name, versions: { [manifest.version]: {} } })
      ),
      /already exists/
    );
    for (const status of [401, 403, 429, 500]) {
      await assert.rejects(
        requireUnpublished(manifest.name, manifest.version, request(status, {})),
        /availability unknown/
      );
    }
    await assert.rejects(
      requireUnpublished(manifest.name, manifest.version, request(200, {})),
      /different package/
    );
    await assert.rejects(
      requireUnpublished(manifest.name, manifest.version, request(200, { name: manifest.name })),
      /no version inventory/
    );
    await assert.rejects(
      requireUnpublished(manifest.name, manifest.version, (async () => {
        throw new Error('offline');
      }) as typeof fetch),
      /offline/
    );
  });
});

// Tiny regular-file tar fixture, used to exercise rejection of dangerous archive contents.
function archive(entries: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [name, content] of Object.entries(entries)) {
    const body = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write(name);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]));
}

const entries = {
  'package/package.json': JSON.stringify(manifest),
  'package/README.md': 'MemoryKit',
  'package/LICENSE': 'MIT',
  'package/dist/index.js': 'export {};',
  'package/dist/index.d.ts': 'export {};',
  'package/dist/history-git/index.js': 'export {};',
  'package/dist/history-git/index.d.ts': 'export {};',
  'package/dist/cli/main.js': '#!/usr/bin/env node\n',
};

describe('release archive inspection', () => {
  it('accepts the public root, Git subpath, declarations and CLI and hashes the actual bytes', () => {
    const report = inspectArchive(archive(entries), manifest);
    assert.equal(report.files.length, Object.keys(entries).length);
    assert.match(report.sha256, /^[0-9a-f]{64}$/);
    assert.match(report.integrity, /^sha512-/);
  });

  it('rejects unintended files, paths, credentials, changed identity and missing targets', () => {
    for (const path of [
      'package/.npmrc',
      'package/tests/key.pem',
      'package/dist/../.env',
      'package/dist/old.test.js',
    ]) {
      const content = path.endsWith('.test.js') ? 'test' : 'secret';
      // Tests cannot ship even if a stale compiled test has a JS extension.
      assert.throws(
        () => inspectArchive(archive({ ...entries, [path]: content }), manifest),
        /unexpected package file/
      );
    }
    assert.throws(
      () =>
        inspectArchive(
          archive({ ...entries, 'package/dist/secret.js': '-----BEGIN PRIVATE KEY-----' }),
          manifest
        ),
      /credential signature/
    );
    assert.throws(
      () =>
        inspectArchive(
          archive({
            ...entries,
            'package/package.json': JSON.stringify({ ...manifest, name: '@other/memorykit' }),
          }),
          manifest
        ),
      /packed name/
    );
    const missing = { ...entries };
    delete (missing as Partial<typeof entries>)['package/dist/history-git/index.js'];
    assert.throws(() => inspectArchive(archive(missing), manifest), /missing export/);
  });
});
