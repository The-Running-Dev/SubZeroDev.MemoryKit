import assert from 'node:assert/strict';
import { it } from 'node:test';
import { setTimeout } from 'node:timers/promises';
import { initStore, openStore } from '../src/sdk/index.ts';
import { context, type RecallSelector } from '../src/workflow/index.ts';
import { commandJson, CommandRecallSelector } from '../src/providers-command/index.ts';
import { StoreUnavailableError } from '../src/model/index.ts';
import { tempDir } from './helpers.ts';

it('enforces one deadline across discovery, selection and verification and cancels provider work', async () => {
  const config = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(config);
  const c = await openStore(config);
  try {
    await c.create({ namespace: 'demo', kind: 'note', content: 'The camera is in the attic.', metadata: { status: 'accepted' } });
    let aborted = false, selected = false;
    const selector: RecallSelector = {
      id: 'bounded',
      async expand(_query, signal) {
        signal!.addEventListener('abort', () => { aborted = true; }, { once: true });
        await setTimeout(200);
        return ['camera'];
      },
      async select() { selected = true; return []; },
    };
    await assert.rejects(context(c, { namespace: 'demo', text: 'camera', deadlineMs: 30 }, undefined, selector),
      (e) => e instanceof StoreUnavailableError && e.details.reason === 'deadline');
    assert.equal(aborted, true);
    await setTimeout(230);
    // A noncooperating discovery call cannot launch a later model phase after the deadline.
    assert.equal(selected, false);
    const controller = new AbortController();
    const command = commandJson({ command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'], timeoutMs: 10000 }, {}, controller.signal);
    controller.abort();
    await assert.rejects(command, (e) => e instanceof StoreUnavailableError && e.details.reason === 'deadline');
    await assert.rejects(commandJson({ command: 'never-start-this' }, {}, controller.signal), /deadline/);
    const retry = new CommandRecallSelector('cancel', { command: 'never-start-this' }, false, false, 1);
    await assert.rejects(retry.select({ query: 'test', passages: [], limit: 1 }, controller.signal), /deadline/);
    assert.equal(retry.attempts, 1);
  } finally { await c.close(); }
});

it('finds old facts from individual expansion terms on conjunctive indexes and bounds disclosure', async () => {
  const config = { path: tempDir(), history: { provider: 'none' as const } };
  await initStore(config);
  const c = await openStore(config);
  try {
    const fact = (await c.create({ namespace: 'demo', kind: 'note', content: 'The camera is in the attic.', metadata: { status: 'accepted' } })).memory;
    for (let i = 0; i < 12; i++) await c.create({ namespace: 'demo', kind: 'note', content: 'Routine housekeeping ' + i, metadata: { status: 'accepted' } });
    await c.create({ namespace: 'foreign', kind: 'note', content: 'The camera is PRIVATE_FOREIGN.', metadata: { status: 'accepted' } });
    const selector: RecallSelector = {
      id: 'aliases', budget: { passages: 4, passageChars: 128, bytes: 2048 },
      async expand() { return ['camera gear location']; },
      async select(request) {
        assert.ok(request.passages.length <= 4);
        assert.ok(Buffer.byteLength(JSON.stringify(request)) <= 2048);
        assert.ok(request.passages.every((p) => p.namespace === 'demo' && !p.content.includes('PRIVATE_FOREIGN')));
        const p = request.passages.find((p) => p.id === fact.id)!;
        assert.ok(p);
        return [{ id: p.id, revision: p.revision, quote: p.content }];
      },
    };
    assert.deepEqual((await context(c, { namespace: 'demo', text: 'Where are my photography supplies?' }, undefined, selector)).items.map((r) => r.id), [fact.id]);
  } finally { await c.close(); }
});
