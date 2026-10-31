// Inspect the bytes that will be installed and published, not npm's proposed file list.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

export function inspectArchive(archive: Buffer, expected: Record<string, unknown>) {
  const tar = gunzipSync(archive);
  const files = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString('utf8')
        .replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = `${prefix ? `${prefix}/` : ''}${field(0, 100)}`;
    const sizeText = field(124, 12).trim();
    assert.match(sizeText, /^[0-7]+$/, `invalid tar size: ${name}`);
    const size = Number.parseInt(sizeText, 8);
    const checksum = Number.parseInt(field(148, 8).trim(), 8);
    const actual = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0
    );
    assert.equal(actual, checksum, `invalid tar header: ${name}`);
    assert.ok(header[156] === 0 || header[156] === 48, `not a regular file: ${name}`);
    assert.ok(!files.has(name), `duplicate tar entry: ${name}`);
    assert.ok(
      /^package\/(?:package\.json|README\.md|LICENSE|dist\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:js|d\.ts))$/.test(
        name
      ),
      `unexpected package file: ${name}`
    );
    const start = offset + 512;
    assert.ok(start + size <= tar.length, `truncated tar entry: ${name}`);
    const content = tar.subarray(start, start + size);
    assert.ok(
      !/-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|\bnpm_[A-Za-z0-9]{36,}\b|\bgh[pousr]_[A-Za-z0-9]{36,}\b|github_pat_[A-Za-z0-9_]{50,}|(?:_authToken|_password)\s*=\s*\S+/i.test(
        content.toString('utf8')
      ),
      `credential signature in package file: ${name}`
    );
    files.set(name, content);
    offset = start + Math.ceil(size / 512) * 512;
  }
  assert.ok(offset + 1024 <= tar.length, 'missing tar end markers');
  assert.ok(
    tar.subarray(offset).every((byte) => byte === 0),
    'unexpected trailing tar data'
  );
  for (const name of ['package/package.json', 'package/README.md', 'package/LICENSE']) {
    assert.ok(files.has(name), `missing ${name}`);
  }
  const manifest = JSON.parse(files.get('package/package.json')!.toString('utf8'));
  // npm can normalize metadata when packing; these distribution contracts must not drift.
  for (const key of [
    'name',
    'version',
    'private',
    'exports',
    'bin',
    'engines',
    'license',
    'publishConfig',
  ]) {
    assert.deepEqual(manifest[key], expected[key], `packed ${key} differs from checkout`);
  }
  for (const target of [
    manifest.main,
    manifest.types,
    ...Object.values(manifest.bin),
    ...Object.values(manifest.exports).flatMap((entry) => Object.values(entry as object)),
  ]) {
    assert.equal(typeof target, 'string');
    assert.ok(
      files.has(`package/${String(target).replace(/^\.\//, '')}`),
      `missing export/bin target: ${target}`
    );
  }
  const binary = files.get(`package/${manifest.bin.memorykit.replace(/^\.\//, '')}`)!;
  assert.ok(binary.toString('utf8').startsWith('#!/usr/bin/env node\n'), 'CLI shebang missing');
  return {
    sha256: createHash('sha256').update(archive).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    files: [...files.keys()].sort(),
    bytes: archive.length,
  };
}

export function inspectArchiveFile(path: string, expected: Record<string, unknown>) {
  return inspectArchive(readFileSync(path), expected);
}
