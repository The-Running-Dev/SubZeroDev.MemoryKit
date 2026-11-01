import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { openStore } from '../src/sdk/index.ts';
import { runCli, tempDir } from './helpers.ts';

for (const storage of ['sqlite', 'markdown'])
  it(`portable ${storage} setup, capture, accept, upgrade and cross-project pilot`, async () => {
    const root = tempDir(),
      store = join(root, 'store'),
      output = join(root, 'v1'),
      next = join(root, 'v2');
    const cli = (...args: string[]) => {
      const result = runCli(args);
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    cli(
      'setup',
      '--store',
      store,
      '--storage',
      storage,
      '--history',
      'none',
      '--output',
      output,
      '--namespace',
      'project/a',
      '--capture'
    );
    const profile = join(output, 'memorykit.profile.json');
    const original = readFileSync(profile, 'utf8');
    const file = join(root, 'capture.json');
    writeFileSync(
      file,
      JSON.stringify({
        namespace: 'project/a',
        source: { host: 'any-llm', sessionId: 'one', eventId: 'one', ref: 'synthetic:one' },
        observations: [{ id: 'user', role: 'user', content: 'The launch uses port 9001.' }],
      })
    );
    const captured = cli('capture', '--profile', profile, '--input', file);
    const client = await openStore({ path: store, history: { provider: 'none' } });
    const candidate = (await client.search({ namespaces: ['project/a'] })).items[0]!;
    assert.equal(candidate.metadata.status, 'candidate');
    await client.close();
    assert.ok(captured);
    assert.equal(cli('context', '--profile', profile, '--text', 'launch port').items.length, 0);
    cli('accept', candidate.id, '--profile', profile, '--expected-revision', '1');
    assert.equal(
      cli('context', '--profile', profile, '--text', 'launch port').items[0].revision,
      2
    );
    assert.equal(
      cli(
        'context',
        '--store',
        store,
        '--namespace',
        'project/b',
        '--history',
        'none',
        '--text',
        'launch port'
      ).items.length,
      0
    );
    cli('upgrade', '--profile', profile, '--output', next);
    assert.equal(readFileSync(profile, 'utf8'), original);
    const upgraded = join(next, 'memorykit.profile.json');
    assert.deepEqual(JSON.parse(readFileSync(upgraded, 'utf8')), JSON.parse(original));
    const doctor = cli('doctor', '--profile', upgraded);
    assert.equal(doctor.status.storage.id, 'storage-' + storage);
    assert.equal(
      cli('context', '--profile', upgraded, '--text', 'launch port').items[0].id,
      candidate.id
    );
    const mcp = JSON.parse(readFileSync(join(next, 'mcp.fragment.json'), 'utf8'));
    assert.ok(mcp.mcpServers.memorykit.args.includes(storage));
  });
