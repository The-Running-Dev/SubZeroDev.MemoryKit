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
  type RecallSelector,
} from 'subzerodev-memorykit';
import { CommandEmbeddings, CommandRecallSelector } from 'subzerodev-memorykit/providers-command';

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
    assert.equal(typeof CommandRecallSelector, 'function');
    const selector: RecallSelector = {
      id: 'consumer-selection',
      async select({ passages }) {
        return passages.map((p) => ({ id: p.id, revision: p.revision, quote: p.content }));
      },
    };
    const selected = await context(
      client,
      { namespace: input.namespace, text: 'Which database mode should concurrent readers use?' },
      undefined,
      selector
    );
    assert.equal(selected.retrieval.mode, 'selected');
    assert.match(selected.text, /SQLite WAL/);
  } finally {
    await client.close();
  }
  console.log('portable workflow consumer ok');
} finally {
  rmSync(path, { recursive: true, force: true });
}
