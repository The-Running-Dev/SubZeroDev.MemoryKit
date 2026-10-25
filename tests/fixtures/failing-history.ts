// S3.2: writes with a history provider that always fails retryably, prints the update's
// outcome as one JSON line and stays alive until it is killed:
// failing-history.ts <store>
import { join } from 'node:path';
import { EMBEDDED_PRINCIPAL } from '../../src/access/index.ts';
import { HistoryProviderError } from '../../src/contracts/index.ts';
import { MemoryHistory } from '../../src/history-memory/index.ts';
import { MemoryService } from '../../src/service/index.ts';
import { SqliteStorage } from '../../src/storage-sqlite/index.ts';

class UnreachableHistory extends MemoryHistory {
  override async record(): Promise<{ historyRef: string }> {
    throw new HistoryProviderError('History is unreachable', true, { reason: 'unreachable' });
  }
}

const storage = new SqliteStorage({ path: join(process.argv[2]!, 'memory.db') });
const service = new MemoryService(storage, new UnreachableHistory());
await service.open();
const client = service.as(EMBEDDED_PRINCIPAL);
const created = await client.create({ namespace: 'demo', kind: 'note', content: 'v1' });
const updated = await client.update({ id: created.memory.id, expectedRevision: 1, content: 'v2' });
process.stdout.write(JSON.stringify(updated) + '\n');
setInterval(() => undefined, 60_000);
