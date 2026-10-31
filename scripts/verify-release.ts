// Non-publishing guards shared by tag publication, PR validation and local checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectArchiveFile } from './check-archive.ts';

export const REGISTRY = 'https://registry.npmjs.org';

export function verifyRelease(
  manifest: Record<string, unknown>,
  options: { publish: boolean; tag: string; approvedName?: string; approvedRegistry?: string }
) {
  assert.match(String(manifest.version), /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(options.tag, `v${manifest.version}`, 'release tag must match package version');
  const config = manifest.publishConfig as { registry?: string; access?: string };
  assert.equal(config.registry, REGISTRY, 'only the reviewed npmjs destination is supported');
  assert.equal(config.access, 'public', 'distribution must be public');
  assert.equal(manifest.license, 'MIT', 'retain the declared license');
  if (options.publish) {
    assert.equal(
      manifest.private,
      false,
      'publication disabled: owner must approve removing private: true'
    );
    assert.equal(
      options.approvedName,
      manifest.name,
      'approved package identity must match manifest'
    );
    assert.equal(options.approvedRegistry, REGISTRY, 'approved registry must match destination');
  }
}

export async function requireUnpublished(
  name: string,
  version: string,
  request: typeof fetch = fetch
) {
  // A 404 is evidence of absence only at the explicit public registry. Other failures block.
  const response = await request(`${REGISTRY}/${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return;
  assert.equal(response.status, 200, `registry status ${response.status}: availability unknown`);
  const data = (await response.json()) as { name?: string; versions?: Record<string, unknown> };
  assert.equal(data.name, name, 'registry returned a different package');
  assert.ok(
    data.versions && typeof data.versions === 'object',
    'registry returned no version inventory'
  );
  assert.ok(!Object.hasOwn(data.versions, version), `${name}@${version} already exists`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  const mode = process.argv[2] ?? 'validate';
  assert.ok(['validate', 'publish', 'archive', 'registry'].includes(mode), 'unknown release check');
  if (mode === 'archive') {
    const report = inspectArchiveFile(process.argv[3]!, manifest);
    if (process.argv[4])
      assert.equal(report.sha256, process.argv[4], 'archive changed after validation');
    console.log(JSON.stringify(report, null, 2));
  } else if (mode === 'registry') {
    await requireUnpublished(manifest.name, manifest.version);
    console.log('version absent at npmjs (not proof of publish permission)');
  } else {
    const publish = mode === 'publish';
    verifyRelease(manifest, {
      publish,
      tag: process.env.RELEASE_TAG || `v${manifest.version}`,
      approvedName: process.env.APPROVED_PACKAGE,
      approvedRegistry: process.env.APPROVED_REGISTRY,
    });
    if (publish) {
      assert.equal(process.env.GITHUB_EVENT_NAME, 'push', 'only a tag push can publish');
      assert.equal(
        process.env.GITHUB_REF,
        `refs/tags/v${manifest.version}`,
        'not the release tag ref'
      );
      assert.equal(process.env.GITHUB_REPOSITORY, 'The-Running-Dev/SubZeroDev.MemoryKit');
      assert.equal(
        execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
        '',
        'release tree is dirty'
      );
      execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
    }
    console.log(`${mode} release identity checks passed; no publication performed`);
  }
}
