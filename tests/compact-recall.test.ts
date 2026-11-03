import assert from 'node:assert/strict';
import { it } from 'node:test';

const { compactRecall } = await import(new URL('../examples/compact-recall.mjs', import.meta.url).href);
const request = { task: 'select', query: 'Where is the equipment?', limit: 2, passages: [
  { id: 'one', revision: 7, namespace: 'project/a', content: 'The microphone is in the cabinet.\nExact punctuation!' },
  { id: 'two', revision: 2, namespace: 'project/a', content: 'Unrelated text.' },
] };

it('maps compact indices to supplied identities, revisions and exact passage text', () => {
  const adapter = compactRecall(request);
  assert.deepEqual(adapter.decode({ matches: [0] }), { selections: [{ id: 'one', revision: 7, quote: request.passages[0]!.content }] });
  assert.deepEqual(adapter.decode({ matches: [] }), { selections: [] });
  for (const matches of [[0, 0], [2], [-1], [0.5], ['0'], [0, 1, 2], null])
    assert.throws(() => adapter.decode({ matches }));
  assert.ok(!JSON.stringify(adapter.input).includes('revision'));
});

it('compact verification cannot add evidence or accept a stale proposal', () => {
  const adapter = compactRecall({ ...request, task: 'verify', selections: [{ id: 'one', revision: 7, quote: 'microphone' }] });
  assert.equal(adapter.decode({ matches: [0] }).selections[0].quote, request.passages[0]!.content);
  assert.throws(() => adapter.decode({ matches: [1] }));
  assert.throws(() => compactRecall({ ...request, task: 'verify', selections: [{ id: 'one', revision: 6 }] }).decode({ matches: [0] }));
});
