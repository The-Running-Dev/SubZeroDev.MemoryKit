// S3.1 in a fresh process: records every module URL resolved while a store with memory
// history creates, updates and reads back one memory, then prints the results as JSON:
// history-modules.ts <store>
import { registerHooks } from 'node:module';

const urls: string[] = [];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    urls.push(result.url);
    return result;
  },
});

const { initStore, openStore } = await import('../../src/sdk/index.ts');
const config = { path: process.argv[2]!, history: { provider: 'memory' as const } };
await initStore(config);
const client = await openStore(config);
try {
  const created = await client.create({ namespace: 'demo', kind: 'note', content: 'first' });
  const id = created.memory.id;
  await client.update({ id, expectedRevision: 1, content: 'second' });
  const revisions = await client.history(id);
  const original = await client.revision(id, 1);
  process.stdout.write(JSON.stringify({ created, revisions, original, urls }));
} finally {
  await client.close();
}
