import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  accept,
  capture,
  context,
  initStore,
  openStore,
  type CaptureInput,
} from 'subzerodev-memorykit';
import { CommandEmbeddings } from 'subzerodev-memorykit/providers-command';

const path = mkdtempSync(join(tmpdir(), 'memorykit-workflow-consumer-'));
try {
  const config = { path, history: { provider: 'none' as const } };
  await initStore(config);
  const client = await openStore(config);
  try {
    const input: CaptureInput = {
      namespace: 'project/demo/app',
      source: { host: 'any-model', sessionId: 's', eventId: 'e', ref: 'test:s' },
      observations: [{ id: 'one', role: 'user', content: 'Use SQLite WAL.' }],
    };
    const result = await capture(client, input);
    assert.equal((await context(client, { namespace: input.namespace })).text, '');
    const record = result.items[0]!.outcome.memory;
    await accept(client, record.id, record.revision);
    assert.match((await context(client, { namespace: input.namespace })).text, /SQLite WAL/);
    assert.equal(typeof CommandEmbeddings, 'function');
  } finally {
    await client.close();
  }
  console.log('portable workflow consumer ok');
} finally {
  rmSync(path, { recursive: true, force: true });
}
