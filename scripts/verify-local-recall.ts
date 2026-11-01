// Opt-in real provider acceptance using small, synthetic data and an installed package.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const { values } = parseArgs({
  options: {
    package: { type: 'string' },
    selector: { type: 'string' },
    report: { type: 'string' },
  },
});
assert.ok(values.package && values.selector, 'Supply --package and --selector');
const root = resolve(values.package);
const api: typeof import('../src/index.ts') = await import(
  pathToFileURL(join(root, 'dist/index.js')).href
);
const providers: typeof import('../src/providers-command/index.ts') = await import(
  pathToFileURL(join(root, 'dist/providers-command/index.js')).href
);
const config = JSON.parse(readFileSync(resolve(values.selector), 'utf8'));
const selector = new providers.CommandRecallSelector(
  config.id,
  config.command,
  config.discovery,
  config.verification,
  config.retries
);
const dir = mkdtempSync(join(tmpdir(), 'memorykit-local-recall-'));
const checks: { name: string; ms: number; passed: boolean; error?: unknown }[] = [];
const namespace = 'project/synthetic/local';
try {
  await api.initStore({ path: dir, history: { provider: 'none' } });
  let client = await api.openStore({ path: dir, history: { provider: 'none' } });
  try {
    const add = async (scope: string, content: string, status = 'accepted') =>
      (await client.create({ namespace: scope, kind: 'note', content, metadata: { status } }))
        .memory;
    const original = await add(namespace, 'Cobalt uses port 4567.');
    await add(namespace, 'Cobalt uses port 9999.', 'candidate');
    await add('project/synthetic/other', 'Cobalt uses port 8888.');
    const check = async (name: string, query: string, expected?: string) => {
      const start = performance.now();
      try {
        const result = await api.context(client, { namespace, text: query }, undefined, selector);
        if (expected) {
          assert.equal(result.items.length, 1);
          assert.ok(result.text.includes(expected));
        } else assert.equal(result.items.length, 0);
        assert.doesNotMatch(result.text, /9999|8888/);
        checks.push({ name, ms: performance.now() - start, passed: true });
      } catch (error) {
        checks.push({
          name,
          ms: performance.now() - start,
          passed: false,
          error:
            error instanceof assert.AssertionError
              ? { message: error.message }
              : api.toProblem(error),
        });
      }
    };
    await check(
      'exact answer with candidate and foreign-project exclusion',
      'Which port does Cobalt use?',
      '4567'
    );
    await check('unsupported question abstention', 'Who invented the telescope?');
    await api.reviewMemory(client, {
      namespace,
      id: original.id,
      expectedRevision: 1,
      action: 'correct',
      content: 'Cobalt uses port 5678.',
    });
    await client.close();
    client = await api.openStore({ path: dir, history: { provider: 'none' } });
    await check(
      'reviewed correction after reopening the store',
      'Which port does Cobalt use?',
      '5678'
    );
  } finally {
    await client.close();
  }
  const json =
    JSON.stringify(
      {
        version: 1,
        installedPackage: true,
        provider: config.id,
        discovery: config.discovery === true,
        verification: config.verification === true,
        checks,
        limitations:
          'Small synthetic local-model smoke test only; not the 58-case task quality gate or a broad answerability claim.',
      },
      null,
      2
    ) + '\n';
  if (values.report) writeFileSync(resolve(values.report), json);
  process.stdout.write(json);
  if (checks.some((check) => !check.passed)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
