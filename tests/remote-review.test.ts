import assert from 'node:assert/strict';
import { it } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { MCP_PROTOCOL_VERSION } from '../src/mcp/index.ts';
import { initStore, openStore, openTokenStore } from '../src/sdk/index.ts';
import { serve } from '../src/server/index.ts';
import { capture, context } from '../src/workflow/index.ts';
import { type MemoryRecord } from '../src/model/index.ts';
import { CLI, tempDir } from './helpers.ts';

for (const storage of ['sqlite', 'markdown'] as const)
  for (const transport of ['http', 'mcp-http', 'mcp-stdio'] as const)
    it(`${storage} ${transport}: attributed review, all decisions, conflicts and validation`, async () => {
      const config = {
        path: tempDir(),
        storage: { provider: storage },
        history: { provider: 'none' as const },
      };
      await initStore(config);
      const local = await openStore(config);
      const ns = 'project/demo';
      await capture(local, {
        namespace: ns,
        source: { host: 'synthetic', sessionId: 's', eventId: 'e', ref: 'test:source' },
        observations: [
          { id: 'a', role: 'user', content: 'Use port 8080.' },
          { id: 'b', role: 'assistant', generated: true, content: 'Use port 8080.' },
          { id: 'c', role: 'assistant', generated: true, content: 'Use port 7000.' },
        ],
      });
      const tokens = await openTokenStore(config);
      const token = (
        await tokens.issue('reviewer', [{ pattern: ns, permissions: ['read', 'write'] }])
      ).secret;
      const reader = (await tokens.issue('reader', [{ pattern: ns, permissions: ['read'] }]))
        .secret;
      await tokens.close();
      const server =
        transport === 'mcp-stdio'
          ? undefined
          : await serve({
              store: config,
              listen: { host: '127.0.0.1', port: 0 },
              auth: { profile: 'local' },
            });
      const mcp =
        transport === 'http'
          ? undefined
          : new Client(
              { name: 'review-test', version: '1' },
              { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
            );
      if (mcp)
        await mcp.connect(
          transport === 'mcp-stdio'
            ? new StdioClientTransport({
                command: process.execPath,
                args: [
                  CLI,
                  'mcp',
                  '--store',
                  config.path,
                  '--storage',
                  storage,
                  '--history',
                  'none',
                ],
              })
            : new StreamableHTTPClientTransport(new URL('/mcp', server!.url), {
                requestInit: { headers: { authorization: `Bearer ${token}` } },
              })
        );
      const call = async (queue: boolean, input: object, credential = token) => {
        if (mcp) {
          const scoped =
            credential === token
              ? mcp
              : new Client(
                  { name: 'review-readonly', version: '1' },
                  { versionNegotiation: { mode: { pin: MCP_PROTOCOL_VERSION } } }
                );
          if (scoped !== mcp)
            await scoped.connect(
              new StreamableHTTPClientTransport(new URL('/mcp', server!.url), {
                requestInit: { headers: { authorization: `Bearer ${credential}` } },
              })
            );
          try {
            const result = await scoped.callTool({
              name: queue ? 'memory_review_queue' : 'memory_review',
              arguments: input as Record<string, unknown>,
            });
            return {
              ok: !result.isError,
              value: result.structuredContent as Record<string, unknown>,
            };
          } finally {
            if (scoped !== mcp) await scoped.close();
          }
        }
        const result = await fetch(
          new URL(queue ? '/v1/review/queue' : '/v1/review', server!.url),
          {
            method: 'POST',
            headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
            body: JSON.stringify(input),
          }
        );
        return { ok: result.ok, value: (await result.json()) as Record<string, unknown> };
      };
      try {
        const queue = await call(true, { namespace: ns });
        assert.equal(queue.ok, true);
        const items = queue.value.items as { memory: MemoryRecord; duplicateIds: string[] }[];
        assert.equal(items.length, 3);
        const user = items.find((i) => i.memory.metadata.sourceRole === 'user')!.memory;
        const duplicate = items.find(
          (i) => i.memory.content === user.content && i.memory.id !== user.id
        )!.memory;
        const rejected = items.find((i) => i.memory.content.includes('7000'))!.memory;
        assert.equal(duplicate.metadata.statement, 'generated');
        assert.deepEqual(user.provenance.evidence, [{ ref: 'test:source' }]);
        const decision = (memory: MemoryRecord, action: string, extra = {}) => ({
          namespace: ns,
          id: memory.id,
          expectedRevision: memory.revision,
          action,
          ...extra,
        });
        for (const input of [
          { namespace: ns, limit: 0 },
          { namespace: ns, limit: 101 },
          { namespace: ns, typo: true },
        ])
          assert.equal((await call(true, input)).ok, false);
        assert.equal((await call(false, decision(user, 'accept', { typo: true }))).ok, false);
        assert.equal(
          (await call(false, decision(user, 'accept', { content: 'silently ignored?' }))).ok,
          false
        );
        assert.equal(
          (await call(false, decision(user, 'accept', { expectedRevision: 0 }))).ok,
          false
        );
        if (transport !== 'mcp-stdio') {
          assert.equal((await call(false, decision(user, 'accept'), reader)).ok, false);
          assert.equal((await call(true, { namespace: 'project/foreign' })).ok, false);
        }
        assert.equal((await call(false, decision(user, 'accept'))).ok, true);
        const conflict = await call(
          false,
          decision(user, 'correct', { content: 'Use port 9000.' })
        );
        assert.equal(conflict.ok, false);
        assert.equal(conflict.value.code, 'RevisionConflict');
        assert.equal(
          (await call(false, decision(duplicate, 'duplicate', { duplicateOf: user.id }))).ok,
          true
        );
        assert.equal((await call(false, decision(rejected, 'reject'))).ok, true);
        const corrected = await call(false, {
          ...decision(user, 'correct', { content: 'Use port 9000.' }),
          expectedRevision: 2,
        });
        assert.equal(corrected.ok, true);
        const replacement = corrected.value.memory as MemoryRecord;
        assert.equal(replacement.metadata.sourceRole, 'user');
        assert.equal(replacement.metadata.statement, 'curated');
        assert.deepEqual(replacement.provenance, user.provenance);
        const recalled = await context(local, { namespace: ns, text: 'port' });
        assert.deepEqual(
          recalled.items.map((r) => r.id),
          [replacement.id]
        );
        assert.ok(!recalled.text.includes('8080') && !recalled.text.includes('7000'));
        assert.equal(((await call(true, { namespace: ns })).value.items as unknown[]).length, 0);
      } finally {
        await mcp?.close();
        await server?.close();
        await local.close();
      }
    });
