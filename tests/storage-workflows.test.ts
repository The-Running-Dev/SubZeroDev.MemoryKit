import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { it } from 'node:test';
import { Pool } from 'pg';
import { initStore, openStore, type StorageConfig } from '../src/sdk/index.ts';
import { runStorageConformance } from '../src/conformance/index.ts';
import { context, type RecallSelector } from '../src/workflow/index.ts';
import { reviewMemory } from '../src/workflow/review.ts';
import { tempDir } from './helpers.ts';

const postgres = process.env.MEMORYKIT_TEST_POSTGRES_URL;
for (const backend of ['sqlite', 'markdown', 'postgres'] as const) {
  it(
    `${backend}: public plugin conformance and old-fact review/recall workflow`,
    {
      skip:
        (backend === 'postgres' && !postgres) ||
        (backend !== 'postgres' && process.env.MEMORYKIT_ONLY_POSTGRES === '1'),
    },
    async () => {
      const storeIds: string[] = [];
      const storage = (): StorageConfig => {
        if (backend !== 'postgres') return { provider: backend };
        const storeId = randomUUID();
        storeIds.push(storeId);
        return {
          provider: 'plugin',
          module: fileURLToPath(new URL('../src/storage-postgres/index.ts', import.meta.url)),
          options: { connectionStringEnv: 'MEMORYKIT_TEST_POSTGRES_URL', storeId },
        };
      };
      try {
        const report = await runStorageConformance(storage);
        assert.equal(report.passed, true, JSON.stringify(report));
        assert.ok(report.cases.length >= 11);
        const config = {
          path: tempDir(),
          storage: storage(),
          history: { provider: 'none' as const },
        };
        await initStore(config);
        let client = await openStore(config);
        try {
          const fact = await client.create({
            namespace: 'project/a',
            kind: 'note',
            content: 'The bicycle is stored in the attic.',
            metadata: { status: 'candidate', sourceRole: 'user' },
          });
          await reviewMemory(client, {
            namespace: 'project/a',
            id: fact.memory.id,
            expectedRevision: 1,
            action: 'accept',
          });
          await client.create({
            namespace: 'project/foreign',
            kind: 'note',
            content: 'The bicycle is stored at PRIVATE_MARKER.',
            metadata: { status: 'accepted' },
          });
          for (let i = 0; i < 210; i++)
            await client.create({
              namespace: 'project/a',
              kind: 'note',
              content: `Routine housekeeping ${i}.`,
              metadata: { status: 'accepted' },
            });
          // Reopen to test persisted search state; deterministic provider isolates backend
          // discovery/lifecycle behavior. Real model quality is measured separately.
          await client.close();
          client = await openStore(config);
          const selector: RecallSelector = {
            id: 'synthetic-bicycle',
            expand: async () => ['bicycle'],
            select: async (input) =>
              input.passages
                .filter((p) => p.content.includes('bicycle'))
                .map((p) => ({ id: p.id, revision: p.revision, quote: p.content })),
            verify: async (_r, selected) => selected,
          };
          for (const text of [
            'Where is my cycling equipment kept?',
            'Please review inventory, write tests, update documentation and tell me where my cycling equipment is kept.',
          ]) {
            const result = await context(
              client,
              { namespace: 'project/a', text, candidateLimit: 50 },
              undefined,
              selector
            );
            assert.deepEqual(
              result.items.map((r) => r.id),
              [fact.memory.id]
            );
            assert.ok(!result.text.includes('PRIVATE_MARKER'));
          }
          const corrected = await reviewMemory(client, {
            namespace: 'project/a',
            id: fact.memory.id,
            expectedRevision: 2,
            action: 'correct',
            content: 'The bicycle is stored in the garage.',
          });
          const result = await context(
            client,
            {
              namespace: 'project/a',
              text: 'Where is my cycling equipment kept?',
              candidateLimit: 50,
            },
            undefined,
            selector
          );
          assert.deepEqual(
            result.items.map((r) => r.id),
            [corrected.memory.id]
          );
          assert.ok(result.text.includes('garage') && !result.text.includes('attic'));
          assert.equal(corrected.memory.metadata.sourceRole, 'user');
          await reviewMemory(client, {
            namespace: 'project/a',
            id: corrected.memory.id,
            expectedRevision: 1,
            action: 'reject',
          });
          assert.equal(
            (
              await context(
                client,
                { namespace: 'project/a', text: 'cycling equipment' },
                undefined,
                selector
              )
            ).items.length,
            0
          );
        } finally {
          await client.close();
        }
      } finally {
        if (storeIds.length) {
          const pool = new Pool({ connectionString: postgres });
          try {
            await pool.query('DELETE FROM memorykit_stores WHERE store_id = ANY($1::text[])', [
              storeIds,
            ]);
          } finally {
            await pool.end();
          }
        }
      }
    }
  );
}
