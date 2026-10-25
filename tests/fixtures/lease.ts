// S3.7: tries to take the drain lease and prints the token, or null when another holder has
// it. The lease is not released, as if the process went on draining:
// lease.ts <database> <holder>
import { SqliteStorage } from '../../src/storage-sqlite/index.ts';

const [path, holder] = process.argv.slice(2);
const storage = new SqliteStorage({ path: path! });
await storage.open();
try {
  const lease = await storage.acquireDrainLease(holder!, 30_000);
  process.stdout.write(JSON.stringify(lease));
} finally {
  await storage.close();
}
