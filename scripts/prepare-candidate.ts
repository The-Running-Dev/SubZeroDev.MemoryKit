// Bind installable archive bytes to a clean source commit. This does not publish or
// attest that model evaluations passed; those results remain separate review evidence.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { inspectArchiveFile } from './check-archive.ts';

const { values } = parseArgs({
  options: { archive: { type: 'string' }, output: { type: 'string' } },
});
assert.ok(values.archive && values.output, 'Supply --archive and --output outside the checkout');
const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
assert.equal(status, '', 'Candidate source tree must be clean');
// Rebuild from the clean checkout before comparing every shipped file. Manifest metadata
// can be normalized by npm; inspectArchiveFile checks its distribution contract separately.
const build = spawnSync('npm run build', { shell: true, encoding: 'utf8' });
assert.equal(build.status, 0, `Candidate rebuild failed: ${build.stderr}`);
assert.equal(
  execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  '',
  'Build changed tracked source'
);
const archive = inspectArchiveFile(resolve(values.archive), manifest);
for (const [path, digest] of Object.entries(archive.fileDigests)) {
  if (path === 'package/package.json') continue;
  const local = resolve(path.slice('package/'.length));
  assert.equal(
    createHash('sha256').update(readFileSync(local)).digest('hex'),
    digest,
    `Archive differs from rebuilt checkout: ${path}`
  );
}
const report = {
  version: 1,
  package: manifest.name,
  packageVersion: manifest.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  archive: basename(values.archive),
  sha256: archive.sha256,
  integrity: archive.integrity,
  bytes: archive.bytes,
  published: false,
  validation:
    'Archive structure, package identity and shipped file bytes checked against the rebuilt clean checkout. See CI and validation reports for test and model results.',
};
writeFileSync(resolve(values.output), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(report, null, 2));
