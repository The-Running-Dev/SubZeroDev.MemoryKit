// Read-only post-publication verification. A successful local pack is never registry proof.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { REGISTRY } from './verify-release.ts';

const { name, version } = JSON.parse(readFileSync('package.json', 'utf8'));
assert.ok(process.env.EXPECTED_INTEGRITY, 'tested archive integrity is required');
const response = await fetch(`${REGISTRY}/${encodeURIComponent(name)}/${version}`, {
  signal: AbortSignal.timeout(30_000),
});
assert.equal(response.status, 200, 'published version is not publicly readable');
const published = (await response.json()) as {
  name: string;
  version: string;
  dist: { integrity: string; tarball: string };
};
assert.equal(published.name, name);
assert.equal(published.version, version);
assert.equal(
  published.dist.integrity,
  process.env.EXPECTED_INTEGRITY,
  'registry metadata differs from tested archive'
);
const url = new URL(published.dist.tarball);
assert.equal(url.origin, REGISTRY, 'registry returned a foreign tarball URL');
const tarball = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
assert.equal(tarball.status, 200, 'published tarball is not publicly readable');
const integrity = `sha512-${createHash('sha512')
  .update(Buffer.from(await tarball.arrayBuffer()))
  .digest('base64')}`;
assert.equal(
  integrity,
  process.env.EXPECTED_INTEGRITY,
  'downloaded registry bytes differ from tested archive'
);
console.log(`Verified public ${name}@${version} at ${REGISTRY}: ${integrity}`);
