import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  CommandDistiller,
  CommandEmbeddings,
  CommandRecallSelector,
  commandJson,
} from '../src/providers-command/index.ts';
import { tempDir } from './helpers.ts';

function provider(code: string, args: string[] = []) {
  const file = join(tempDir(), 'provider with spaces.mjs');
  writeFileSync(file, code);
  return { command: process.execPath, args: [file, ...args] };
}
const read =
  "let data = ''; for await (const chunk of process.stdin) data += chunk; const request = JSON.parse(data);";
describe('optional command providers', () => {
  it('runs the shipped Ollama adapter against chat and embedding endpoints', async () => {
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ path: req.url!, body });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          req.url === '/api/embed'
            ? { embeddings: [[1, 0]] }
            : {
                message: {
                  content: JSON.stringify(
                    typeof body.format === 'object'
                      ? { matches: [0] }
                      : {
                          observations: [{ sourceId: 'one', content: 'Use SQLite.' }],
                        }
                  ),
                },
              }
        )
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const config = {
      command: process.execPath,
      args: [
        fileURLToPath(new URL('../examples/ollama-provider.mjs', import.meta.url)),
        '--model',
        'test-model',
        '--url',
        `http://127.0.0.1:${address.port}`,
      ],
    };
    try {
      assert.deepEqual(await new CommandEmbeddings('test', config).embed(['hello'], 'query'), [
        [1, 0],
      ]);
      const observations = await new CommandDistiller(config).distill({
        namespace: 'demo',
        source: { host: 'test', sessionId: 's', eventId: 'e', ref: 'test:s' },
        observations: [{ id: 'one', role: 'user', content: 'I prefer SQLite.' }],
      });
      assert.deepEqual(observations, [
        { id: 'one', role: 'user', content: 'Use SQLite.', generated: true, evidence: [] },
      ]);
      assert.equal(requests[0]!.path, '/api/embed');
      assert.equal(requests[0]!.body.truncate, false);
      assert.equal(requests[1]!.path, '/api/chat');
      assert.equal(requests[1]!.body.stream, false);
      assert.deepEqual(
        await new CommandRecallSelector('ollama-test', config).select({
          query: 'database',
          limit: 1,
          passages: [
            { id: 'one', revision: 1, namespace: 'demo', content: 'Use SQLite.', truncated: false },
          ],
        }),
        [{ id: 'one', revision: 1, quote: 'Use SQLite.' }]
      );
      assert.equal(requests[2]!.path, '/api/chat');
      assert.equal(typeof requests[2]!.body.format, 'object');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  it('passes literal arguments and JSON on stdin without a shell', async () => {
    const config = provider(
      read + 'console.log(JSON.stringify({ request, arg: process.argv[2] }));',
      ['$(echo secret) & literal']
    );
    assert.deepEqual(await commandJson(config, { text: '😀\nquotes " and <data>' }), {
      request: { text: '😀\nquotes " and <data>' },
      arg: '$(echo secret) & literal',
    });
  });
  it('passes the recall selection protocol and requires a selections array', async () => {
    const input = {
      query: 'cycling equipment',
      limit: 1,
      passages: [
        {
          id: 'one',
          revision: 3,
          namespace: 'demo',
          content: 'Bicycle in shed.',
          truncated: false,
        },
      ],
    };
    const selector = new CommandRecallSelector(
      'test',
      provider(
        read +
          'if(request.version !== 1 || request.task !== "select" || request.query !== "cycling equipment") process.exit(1); console.log(JSON.stringify({selections:[{id:request.passages[0].id,revision:request.passages[0].revision,quote:request.passages[0].content}]}));'
      )
    );
    assert.deepEqual(await selector.select(input), [
      { id: 'one', revision: 3, quote: 'Bicycle in shed.' },
    ]);
    await assert.rejects(
      new CommandRecallSelector('bad', provider(read + 'console.log("{}");')).select(input),
      /return selections/
    );
  });
  it('uses a separate opt-in verification protocol and allows abstention', async () => {
    const input = {
      query: 'bicycle',
      limit: 1,
      passages: [
        {
          id: 'one',
          revision: 2,
          namespace: 'demo',
          content: 'Bicycle in shed.',
          truncated: false,
        },
      ],
    };
    const proposals = [{ id: 'one', revision: 2, quote: 'Bicycle' }];
    const config = provider(
      read +
        'if(request.task!=="verify" || request.selections[0].quote!=="Bicycle" || request.passages.length!==1) process.exit(1); console.log(JSON.stringify({selections:[]}));'
    );
    assert.equal(new CommandRecallSelector('off', config).verify, undefined);
    assert.deepEqual(
      await new CommandRecallSelector('on', config, false, true).verify!(input, proposals),
      []
    );
    await assert.rejects(
      new CommandRecallSelector('bad', provider(read + 'console.log("{}");'), false, true).verify!(
        input,
        proposals
      ),
      /return selections/
    );
  });
  it('bounds execution and output, and does not expose provider errors or invalid output', async () => {
    await assert.rejects(
      commandJson({ ...provider('setInterval(() => {}, 1000);'), timeoutMs: 100 }, {}),
      /timed out/
    );
    await assert.rejects(
      commandJson({ ...provider(read + 'console.log("x".repeat(1000));'), maxOutputBytes: 50 }, {}),
      /output limit/
    );
    await assert.rejects(
      commandJson(provider(read + 'console.log("secret invalid-json");'), {}),
      /returned invalid JSON/
    );
    await assert.rejects(
      commandJson(provider(read + 'console.error("secret"); process.exit(1);'), {}),
      /provider failed/
    );
  });
  it('retries one timeout only and counts actual process attempts', async () => {
    const flag = join(tempDir(), 'first-attempt');
    const config = provider(
      `import { existsSync, writeFileSync } from 'node:fs'; ${read} if(!existsSync(process.argv[2])) { writeFileSync(process.argv[2], '1'); process.exit(75); } console.log(JSON.stringify({selections:[]}));`,
      [flag]
    );
    const input = { query: 'test', limit: 1, passages: [] };
    const selector = new CommandRecallSelector('retry', config, false, false, 1);
    assert.deepEqual(await selector.select(input), []);
    assert.equal(selector.attempts, 2);
    for (const code of ['console.log("invalid");', 'process.exit(1);', 'console.log("{}");']) {
      const invalid = new CommandRecallSelector('invalid', provider(read + code), false, false, 1);
      await assert.rejects(invalid.select(input));
      assert.equal(invalid.attempts, 1);
    }
    assert.throws(() => new CommandRecallSelector('bad', config, false, false, 2));
  });
  it('implements model-independent distillation and embedding protocols', async () => {
    const distiller = new CommandDistiller(
      provider(read + 'console.log(JSON.stringify({ observations: request.input.observations }));')
    );
    const input = {
      namespace: 'demo',
      source: { host: 'test', sessionId: 's', eventId: 'e', ref: 'test:s' },
      observations: [{ id: 'one', role: 'user' as const, content: 'Hello' }],
    };
    assert.deepEqual(await distiller.distill(input), input.observations);
    const embedding = new CommandEmbeddings(
      'test-v1',
      provider(read + 'console.log(JSON.stringify({ vectors: request.texts.map(() => [1, 0]) }));')
    );
    assert.deepEqual(await embedding.embed(['a', 'b'], 'document'), [
      [1, 0],
      [1, 0],
    ]);
    await assert.rejects(
      new CommandDistiller(provider(read + 'console.log("{}");')).distill(input),
      /return observations/
    );
  });
});
