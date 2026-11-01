import { runStorageConformance } from 'subzerodev-memorykit/conformance';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownStorage, initStore, openStore, type StoragePlugin } from 'subzerodev-memorykit';

const root = mkdtempSync(join(tmpdir(), 'memorykit-plugin-consumer-'));
try {
  const plugin: StoragePlugin = {
    async createStorage({ path }) {
      const storage = new MarkdownStorage({ path: join(path, 'markdown') });
      return { storage, tokens: storage };
    },
  };
  assert.equal(typeof plugin.createStorage, 'function');
  // Keep the external module alongside this consumer to resolve the installed package.
  const module = join(process.cwd(), 'installed-plugin.mjs');
  writeFileSync(
    module,
    `import {MarkdownStorage} from 'subzerodev-memorykit';
    export async function createStorage({path}) {
      const storage = new MarkdownStorage({path:path+'/markdown'});
      return {storage,tokens:storage};
    }`
  );
  const config = {
    path: root,
    storage: { provider: 'plugin' as const, module },
    history: { provider: 'git' as const },
  };
  await initStore(config);
  const client = await openStore(config);
  try {
    const result = await client.create({
      namespace: 'demo',
      kind: 'note',
      content: 'installed plugin with Git history',
    });
    assert.equal((await client.get(result.memory.id)).content, result.memory.content);
    assert.equal((await client.status()).storage.id, 'storage-markdown');
    assert.equal((await client.syncHistory()).blocked, null);
  } finally {
    await client.close();
  }
  for (const storage of [
    { provider: 'sqlite' as const },
    { provider: 'markdown' as const },
    config.storage,
  ]) {
    const report = await runStorageConformance(storage);
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.ok(report.cases.length >= 11);
  }
  console.log('installed storage plugin and Git history ok');
} finally {
  rmSync(root, { recursive: true, force: true });
}
