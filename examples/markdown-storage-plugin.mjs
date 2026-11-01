// Example external plugin. Install MemoryKit alongside this module so Node can resolve it.
import { join } from 'node:path';
import { MarkdownStorage } from 'subzerodev-memorykit';

export async function createStorage({ path, options }) {
  const storage = new MarkdownStorage({
    path: join(path, 'markdown'),
    busyTimeoutMs: options.busyTimeoutMs ?? 5000,
  });
  return { storage, tokens: storage };
}
