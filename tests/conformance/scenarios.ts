import assert from 'node:assert/strict';
import { newMemoryId, type RetrievedItem } from '../../src/model/index.ts';
import { tempDir } from '../helpers.ts';
import type { Driver, Result } from './driver.ts';

export interface Scenario {
  readonly name: string;
  run(driver: Driver): Promise<void>;
}

function value<T>(result: Result<T>): T {
  if (!result.ok) assert.fail(`expected success, got ${JSON.stringify(result.problem)}`);
  return result.value;
}

function problem(result: Result<unknown>, code: string): void {
  assert.equal(result.ok, false, `expected ${code}`);
  if (!result.ok) assert.equal(result.problem.code, code);
}

export const SCENARIOS: Scenario[] = [
  {
    name: 'create then get returns the same record',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const outcome = value(
        await driver.create(store, {
          namespace: 'demo/notes',
          key: 'first',
          kind: 'note',
          content: 'hello',
          metadata: { priority: 'high' },
        })
      );
      assert.equal(outcome.storage, 'persisted');
      // A slow export can outlast historyWaitMs, so the write may report pending.
      assert.ok(
        outcome.history === 'persisted' || outcome.history === 'pending',
        String(outcome.history)
      );
      const memory = outcome.memory as Record<string, unknown>;
      assert.equal(memory.revision, 1);
      assert.equal(memory.state, 'active');
      assert.deepEqual(value(await driver.get(store, memory.id as string)), memory);
      const status = value(await driver.status(store));
      const history = status.history as Record<string, unknown>;
      assert.equal(history.id, 'history-git', 'Git history is the default');
    },
  },
  {
    name: 'unknown ids and invalid input fail with the contract codes',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      problem(await driver.get(store, newMemoryId()), 'NotFound');
      problem(
        await driver.create(store, { namespace: 'Demo', kind: 'note', content: 'x' }),
        'ValidationFailed'
      );
      problem(
        await driver.create(store, {
          namespace: 'demo',
          kind: 'note',
          content: '{bad',
          contentType: 'application/json',
        }),
        'ValidationFailed'
      );
    },
  },
  {
    name: 'S2.6 update conflicts, replays and refuses a reused operation id',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'v1' })
      );
      const id = (created.memory as Record<string, unknown>).id as string;

      // S2.1: a write against revision 1 lands at 2; a second one against 1 conflicts.
      const won = value(
        await driver.update(store, { id, expectedRevision: 1, content: 'winner' }, 'op-a')
      );
      const memory = won.memory as Record<string, unknown>;
      assert.equal(memory.revision, 2);
      assert.equal(memory.content, 'winner');
      assert.equal(memory.kind, 'note');
      const lost = await driver.update(store, { id, expectedRevision: 1, content: 'loser' });
      problem(lost, 'RevisionConflict');
      if (!lost.ok) assert.equal(lost.problem.details.currentRevision, 2);

      // S2.2: the same operation id and body replays the stored outcome.
      const again = value(
        await driver.update(store, { id, expectedRevision: 1, content: 'winner' }, 'op-a')
      );
      assert.deepEqual(again, won);

      // S2.3: the same operation id with another body is refused.
      problem(
        await driver.update(store, { id, expectedRevision: 1, content: 'other' }, 'op-a'),
        'IdempotencyMismatch'
      );
      const current = value(await driver.get(store, id));
      assert.equal(current.revision, 2);
      assert.equal(current.content, 'winner');
    },
  },
  {
    name: 'S3 operation status, store status and namespace policies',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'x' }, 'op-1')
      );
      const memory = created.memory as Record<string, unknown>;
      // A slow export can outlast historyWaitMs, so the write may report pending; the export
      // still finishes before the store closes.
      const operation = value(await driver.operation(store, 'op-1'));
      assert.equal(typeof operation.historyRef, 'string');
      if (created.history === 'persisted') assert.equal(operation.historyRef, created.historyRef);
      assert.deepEqual(operation, {
        operationId: 'op-1',
        memoryId: memory.id,
        revision: 1,
        storage: 'persisted',
        history: 'persisted',
        historyRef: operation.historyRef,
      });
      problem(await driver.operation(store, 'op-unknown'), 'NotFound');
      const revisions = value(await driver.history(store, memory.id as string)) as unknown[];
      assert.equal(revisions.length, 1);

      const status = value(await driver.status(store));
      assert.equal(status.contractVersion, 1);
      assert.equal((status.storage as Record<string, unknown>).id, 'storage-sqlite');
      assert.equal((status.history as Record<string, unknown>).id, 'history-git');
      assert.deepEqual(status.historyQueue, { pending: 0, blocked: null, lastError: null });

      assert.deepEqual(value(await driver.getNamespace(store, 'demo')), {
        name: 'demo',
        historyPolicy: 'full',
      });
      assert.deepEqual(value(await driver.setNamespacePolicy(store, 'demo', 'metadata')), {
        name: 'demo',
        historyPolicy: 'metadata',
      });
      assert.equal(value(await driver.getNamespace(store, 'demo')).historyPolicy, 'metadata');
      problem(await driver.setNamespacePolicy(store, 'demo', 'partial'), 'ValidationFailed');
      problem(await driver.getNamespace(store, 'Demo'), 'ValidationFailed');
    },
  },
  {
    name: 'update validates its input and maps an unknown id to NotFound',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      problem(
        await driver.update(store, { id: newMemoryId(), expectedRevision: 1, content: 'x' }),
        'NotFound'
      );
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: '{}' })
      );
      const id = (created.memory as Record<string, unknown>).id as string;
      problem(
        await driver.update(store, { id, expectedRevision: 0, content: 'x' }),
        'ValidationFailed'
      );
      problem(
        await driver.update(store, {
          id,
          expectedRevision: 1,
          contentType: 'application/json',
          content: '{bad',
        }),
        'ValidationFailed'
      );
    },
  },
  {
    name: 'S5 supersede, tombstone, restore and an invalid transition',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'old' })
      );
      const a = (created.memory as Record<string, unknown>).id as string;

      const superseded = value(
        await driver.supersede(store, {
          id: a,
          expectedRevision: 1,
          replacement: { kind: 'note', content: 'new' },
        })
      );
      const b = superseded.memory as Record<string, unknown>;
      assert.equal(b.namespace, 'demo');
      assert.deepEqual(b.links, [{ type: 'supersedes', target: a }]);
      const related = superseded.related as Record<string, unknown>[];
      assert.deepEqual(
        related.map((m) => [m.id, m.state, m.revision, m.supersededBy]),
        [[a, 'superseded', 2, [b.id]]]
      );
      const target = value(await driver.get(store, a));
      assert.equal(target.state, 'superseded');
      assert.deepEqual(target.supersededBy, [b.id]);

      const tombstoned = value(
        await driver.transition(store, 'tombstone', { id: a, expectedRevision: 2 })
      ).memory as Record<string, unknown>;
      assert.deepEqual(
        [tombstoned.revision, tombstoned.state, tombstoned.priorState],
        [3, 'tombstoned', 'superseded']
      );
      problem(
        await driver.update(store, { id: a, expectedRevision: 2, content: 'stale' }),
        'RevisionConflict'
      );
      problem(
        await driver.transition(store, 'archive', { id: a, expectedRevision: 3 }),
        'InvalidTransition'
      );
      assert.equal(value(await driver.get(store, a)).revision, 3);

      const restored = value(
        await driver.transition(store, 'restore', { id: a, expectedRevision: 3 })
      ).memory as Record<string, unknown>;
      assert.deepEqual(
        [restored.revision, restored.state, restored.priorState],
        [4, 'superseded', null]
      );
    },
  },
  {
    name: 'S11 purge reports each boundary, replays by operation id and refuses a stale revision',
    async run(driver) {
      if (driver.purge === undefined) return;
      const store = tempDir();
      value(await driver.init(store));
      const created = value(
        await driver.create(store, { namespace: 'demo', kind: 'note', content: 'secret' })
      );
      const id = (created.memory as Record<string, unknown>).id as string;
      problem(await driver.purge(store, { id, expectedRevision: 2 }), 'RevisionConflict');
      const report = value(await driver.purge(store, { id, expectedRevision: 1 }, 'purge-1'));
      assert.equal(report.memoryId, id);
      assert.equal(report.operationId, 'purge-1');
      const results = Object.fromEntries(
        Object.entries(report.boundaries as Record<string, { result: string }>).map(
          ([name, item]) => [name, item.result]
        )
      );
      // The default store keeps Git history, which the service waits for.
      assert.deepEqual(results, {
        current_storage: 'removed',
        pending_history: 'removed',
        history_current_tree: 'removed',
        history_past_revisions: 'retained',
        history_remotes: 'not_modified',
        external_copies: 'outside_control',
      });
      problem(await driver.get(store, id), 'NotFound');
      assert.deepEqual(
        value(await driver.purge(store, { id, expectedRevision: 1 }, 'purge-1')),
        report
      );
      problem(await driver.purge(store, { id, expectedRevision: 1 }), 'NotFound');
    },
  },
  {
    name: 'S6 search pages, filters and rejects an oversized limit and a foreign cursor',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const ids: string[] = [];
      for (const [kind, content] of [
        ['note', 'the lighthouse keeper'],
        ['lesson', 'a lighthouse at dusk'],
        ['note', 'lighthouse beams'],
        ['note', 'harbour fog'],
      ]) {
        const created = value(await driver.create(store, { namespace: 'demo', kind, content }));
        ids.push((created.memory as Record<string, unknown>).id as string);
      }
      value(await driver.transition(store, 'tombstone', { id: ids[2], expectedRevision: 1 }));

      const idsOf = (page: Record<string, unknown>) =>
        (page.items as Record<string, unknown>[]).map((item) => item.id as string);
      const first = value(await driver.search(store, { text: 'lighthouse', limit: 1 }));
      assert.equal(first.completeness, 'complete');
      assert.equal(typeof first.nextCursor, 'string');
      const second = value(
        await driver.search(store, { text: 'lighthouse', limit: 1, cursor: first.nextCursor })
      );
      assert.equal(second.nextCursor, null);
      assert.deepEqual([...idsOf(first), ...idsOf(second)].sort(), [ids[0], ids[1]].sort());

      const lessons = value(await driver.search(store, { text: 'lighthouse', kinds: ['lesson'] }));
      assert.deepEqual(idsOf(lessons), [ids[1]]);
      const tombstoned = value(
        await driver.search(store, { namespaces: ['demo'], states: ['tombstoned'] })
      );
      assert.deepEqual(idsOf(tombstoned), [ids[2]]);

      problem(await driver.search(store, { limit: 101 }), 'LimitExceeded');
      problem(
        await driver.search(store, { text: 'fog', cursor: first.nextCursor }),
        'ValidationFailed'
      );
    },
  },
  {
    name: 'S15 retrieve returns compact bounded items in search order',
    async run(driver) {
      const store = tempDir();
      value(await driver.init(store));
      const long = 'r'.repeat(257);
      const created = value(
        await driver.create(store, {
          namespace: 'demo',
          key: 'keeper',
          kind: 'note',
          content: `${'calm sea. '.repeat(40)}the lighthouse keeper rows ashore`,
          metadata: { secret: 'harbour' },
          provenance: {
            reason: 'never returned',
            evidence: ['e1', long, 'e2', 'e3', 'e4', 'e5', 'e6'].map((ref) => ({ ref })),
          },
        })
      );
      const keeper = created.memory as Record<string, unknown>;
      const other = value(
        await driver.create(store, { namespace: 'demo', kind: 'lesson', content: 'a lighthouse' })
      ).memory as Record<string, unknown>;
      const replaced = value(
        await driver.supersede(store, {
          id: other.id,
          expectedRevision: 1,
          replacement: { kind: 'lesson', content: 'the lighthouse, rebuilt' },
        })
      ).memory as Record<string, unknown>;

      const query = { text: 'lighthouse', states: ['active', 'superseded'] };
      const searched = value(await driver.search(store, query));
      const result = value(await driver.retrieve(store, { ...query, excerptChars: 60 }));
      assert.deepEqual(Object.keys(result).sort(), ['completeness', 'items', 'nextCursor']);
      const items = result.items as RetrievedItem[];
      assert.equal(items.length, 3);
      assert.deepEqual(
        items.map((item) => item.id),
        (searched.items as Record<string, unknown>[]).map((item) => item.id)
      );
      const item = items.find((candidate) => candidate.id === keeper.id)!;
      assert.deepEqual(Object.keys(item).sort(), [
        'contentBytes',
        'evidence',
        'excerpt',
        'id',
        'key',
        'kind',
        'match',
        'namespace',
        'revision',
        'state',
        'supersededBy',
        'updatedAt',
      ]);
      assert.equal(item.key, 'keeper');
      assert.equal(item.contentBytes, (keeper.content as string).length);
      assert.equal(item.excerpt.truncated, true);
      assert.ok(Array.from(item.excerpt.text as string).length <= 60);
      assert.match(item.excerpt.text, /lighthouse keeper/u);
      assert.doesNotMatch(item.excerpt.text, /harbour/u, 'metadata never reaches the excerpt');
      assert.deepEqual(item.evidence, { refs: ['e1', 'e2', 'e3', 'e4', 'e5'], omitted: 2 });
      assert.deepEqual(item.match.terms, ['lighthouse']);
      assert.equal(typeof item.match.score, 'number');
      // A term matched only in metadata is listed, but the excerpt still comes from the content.
      const both = value(await driver.retrieve(store, { text: 'lighthouse harbour' }));
      const [matched] = both.items as RetrievedItem[];
      assert.equal(matched!.id, keeper.id);
      assert.deepEqual(matched!.match.terms, ['lighthouse', 'harbour']);
      const superseded = items.find((candidate) => candidate.id === other.id)!;
      assert.deepEqual(superseded.supersededBy, { ids: [replaced.id], omitted: 0 });
      assert.deepEqual(superseded.match.terms, ['lighthouse']);

      // S15.6: every returned id resolves to the full record at the returned revision.
      for (const found of items) {
        const record = value(await driver.get(store, found.id));
        assert.equal(record.revision, found.revision);
      }

      const first = value(await driver.retrieve(store, { ...query, limit: 1 }));
      const second = value(
        await driver.retrieve(store, { ...query, limit: 2, cursor: first.nextCursor })
      );
      assert.deepEqual(
        [...(first.items as RetrievedItem[]), ...(second.items as RetrievedItem[])].map(
          (found) => found.id
        ),
        items.map((found) => found.id)
      );
      assert.equal(second.nextCursor, null);

      problem(await driver.retrieve(store, { states: ['active'] }), 'ValidationFailed');
      problem(await driver.retrieve(store, { text: 'x', limit: 51 }), 'ValidationFailed');
      problem(await driver.retrieve(store, { text: 'x', excerptChars: 1001 }), 'ValidationFailed');
      const page = value(await driver.search(store, { text: 'lighthouse', limit: 1 }));
      problem(
        await driver.retrieve(store, { text: 'lighthouse', limit: 1, cursor: page.nextCursor }),
        'ValidationFailed'
      );
      problem(
        await driver.search(store, { text: 'lighthouse', limit: 1, cursor: first.nextCursor }),
        'ValidationFailed'
      );
    },
  },
  {
    name: 'S15.5 retrieve shows a reader of one namespace nothing from the other',
    async run(driver) {
      if (driver.retrieveAs === undefined) return;
      const store = tempDir();
      value(await driver.init(store));
      const open = value(
        await driver.create(store, {
          namespace: 'team/open',
          kind: 'note',
          content: 'lighthouse log',
          provenance: { evidence: [{ ref: 'open-ref' }] },
        })
      ).memory as Record<string, unknown>;
      value(
        await driver.supersede(store, {
          id: open.id,
          expectedRevision: 1,
          replacement: { namespace: 'team/closed', kind: 'note', content: 'lighthouse moved' },
        })
      );
      value(
        await driver.create(store, {
          namespace: 'team/closed',
          kind: 'note',
          content: 'lighthouse beacon secret',
          provenance: { evidence: [{ ref: 'closed-ref' }] },
        })
      );
      const query = { text: 'lighthouse', states: ['active', 'superseded'] };
      const all = value(await driver.retrieve(store, query));
      assert.equal((all.items as unknown[]).length, 3);

      const reader = [{ pattern: 'team/open', permissions: ['read' as const] }];
      const seen = value(await driver.retrieveAs(store, reader, query));
      assert.deepEqual(seen.items, [
        {
          ...(all.items as Record<string, unknown>[]).find((item) => item.id === open.id),
          supersededBy: { ids: [], omitted: 0 },
        },
      ]);
      assert.doesNotMatch(JSON.stringify(seen), /closed|secret|moved/u);
      problem(
        await driver.retrieveAs(store, reader, { ...query, namespaces: ['team/closed'] }),
        'Forbidden'
      );
    },
  },
];
