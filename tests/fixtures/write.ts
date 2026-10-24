// Runs one write in a fresh process and prints the outcome or problem as JSON:
// write.ts <store> create|update <input-json> [operation-id]
import { toProblem } from '../../src/model/index.ts';
import { openStore } from '../../src/sdk/index.ts';

const [path, operation, json, operationId] = process.argv.slice(2);
const client = await openStore({ path: path! });
const opts = operationId === undefined ? {} : { operationId };
try {
  const input = JSON.parse(json!);
  const outcome =
    operation === 'create' ? await client.create(input, opts) : await client.update(input, opts);
  process.stdout.write(JSON.stringify({ ok: true, value: outcome }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, problem: toProblem(error) }));
} finally {
  await client.close();
}
