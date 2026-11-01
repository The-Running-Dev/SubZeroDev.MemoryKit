import assert from 'node:assert/strict';
import { it } from 'node:test';
import { initStore, openStore } from '../src/sdk/index.ts';
import { context, type RecallSelector } from '../src/workflow/index.ts';
import { ValidationFailedError } from '../src/model/index.ts';
import { tempDir } from './helpers.ts';

it('verification repairs citations, excludes unproposed records and injects only supported excerpts', async () => {
  const config = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(config);
  const c = await openStore(config);
  try {
    const target = (
      await c.create({
        namespace: 'demo',
        kind: 'note',
        content: 'Cobalt code is 42. Unrelated personal detail.',
        metadata: { status: 'accepted' },
      })
    ).memory;
    const other = (
      await c.create({
        namespace: 'demo',
        kind: 'note',
        content: 'The blue bicycle is in the shed.',
        metadata: { status: 'accepted' },
      })
    ).memory;
    const selector: RecallSelector = {
      id: 'audit',
      select: async () => [{ id: target.id, revision: 1, quote: 'paraphrased' }],
      verify: async (request, proposals) => {
        assert.deepEqual(
          request.passages.map((p) => p.id),
          [target.id]
        );
        assert.equal(proposals[0]!.quote, 'paraphrased');
        return [{ id: target.id, revision: 1, quote: 'Cobalt code is 42.' }];
      },
    };
    const result = await context(
      c,
      { namespace: 'demo', text: 'What is the Cobalt code?' },
      undefined,
      selector
    );
    assert.match(result.text, /Cobalt code is 42/);
    assert.doesNotMatch(result.text, /personal detail/);
    const originalSelect = selector.select;
    selector.select = async () => [{ id: target.id, revision: 1, quote: 'x'.repeat(1025) }];
    await assert.rejects(
      context(c, { namespace: 'demo', text: 'code', maxBytes: 1024 }, undefined, selector),
      ValidationFailedError
    );
    selector.select = originalSelect;
    selector.verify = async () => [{ id: other.id, revision: 1, quote: other.content }];
    await assert.rejects(
      context(c, { namespace: 'demo', text: 'code' }, undefined, selector),
      ValidationFailedError
    );
    selector.verify = async () => [];
    assert.equal(
      (await context(c, { namespace: 'demo', text: 'code' }, undefined, selector)).items.length,
      0
    );
    selector.verify = async () => {
      await c.update({ id: target.id, expectedRevision: 1, content: 'Cobalt code changed.' });
      return [{ id: target.id, revision: 1, quote: 'Cobalt code is 42.' }];
    };
    const raced = await context(c, { namespace: 'demo', text: 'code' }, undefined, selector);
    assert.equal(raced.items.length, 0);
    assert.ok(raced.reasons.includes('records_changed'));
  } finally {
    await c.close();
  }
});
