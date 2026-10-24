// Opens a store in a fresh process and prints one record as JSON: get-record.ts <store> <id>
import { openStore } from '../../src/sdk/index.ts';

const [path, id] = process.argv.slice(2);
const client = await openStore({ path: path! });
try {
  process.stdout.write(JSON.stringify(await client.get(id!)));
} finally {
  await client.close();
}
