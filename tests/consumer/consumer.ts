// A consumer of the installed package. It imports only the package's public entry, never a
// storage or history module by path (A4). scripts/check-package.ts type-checks and runs it in
// a directory where the packed tarball is installed.

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStore, openStore, type MemoryClient, type StoreConfig } from 'subzerodev-memorykit';

const dir = mkdtempSync(join(tmpdir(), 'memorykit-consumer-'));
try {
  const config: StoreConfig = { path: dir, history: { provider: 'memory' } };
  await initStore(config);
  const store: MemoryClient & { close(): Promise<void> } = await openStore(config);
  try {
    const created = await store.create({ namespace: 'app/notes', kind: 'note', content: 'hello' });
    assert.equal((await store.get(created.memory.id)).content, 'hello');
    const found = await store.search({ namespaces: ['app/*'], text: 'hello' });
    assert.deepEqual(
      found.items.map((item) => item.id),
      [created.memory.id]
    );
    assert.equal((await store.revision(created.memory.id, 1)).revision, 1);
  } finally {
    await store.close();
  }

  // Only the entry is exported; implementation modules cannot be reached by path. The
  // specifier is a variable because the type checker refuses it as well.
  const internal: string = 'subzerodev-memorykit/dist/storage-sqlite/index.js';
  await assert.rejects(import(internal), {
    code: 'ERR_PACKAGE_PATH_NOT_EXPORTED',
  });
  console.log('consumer ok');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
