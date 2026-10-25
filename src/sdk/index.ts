import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDED_PRINCIPAL, type Principal } from '../access/index.ts';
import type { HistoryPolicy, HistoryProvider } from '../contracts/index.ts';
import { MemoryHistory } from '../history-memory/index.ts';
import { StoreUnavailableError, UnsupportedError, ValidationFailedError } from '../model/index.ts';
import { MemoryService, type MemoryClient, type ServiceConfig } from '../service/index.ts';
import { SqliteStorage } from '../storage-sqlite/index.ts';

export interface StoreConfig {
  path: string;
  history?:
    { provider: 'git'; repository?: string } | { provider: 'memory' } | { provider: 'none' };
  defaultHistoryPolicy?: HistoryPolicy;
  service?: ServiceConfig;
}

export const DATABASE_FILE = 'memory.db';

function databasePath(config: StoreConfig): string {
  if (typeof config?.path !== 'string' || config.path.length === 0) {
    throw new ValidationFailedError('Invalid path: required', {
      field: 'path',
      reason: 'required',
    });
  }
  return join(config.path, DATABASE_FILE);
}

// Git history arrives in S4; until then a store runs without history unless the caller asks
// for history held in memory.
function historyProvider(config: StoreConfig): HistoryProvider | null {
  const provider = config.history?.provider ?? 'none';
  if (provider === 'none') return null;
  if (provider === 'memory') return new MemoryHistory();
  throw new UnsupportedError('This history provider is not available yet', {
    capability: `history.${provider}`,
  });
}

export async function initStore(config: StoreConfig): Promise<void> {
  const file = databasePath(config);
  historyProvider(config);
  if (existsSync(file)) {
    throw new StoreUnavailableError('The directory is already a store', {
      reason: 'already_a_store',
    });
  }
  try {
    mkdirSync(config.path, { recursive: true });
  } catch {
    throw new StoreUnavailableError('The store directory cannot be created', {
      reason: 'open_failed',
    });
  }
  const storage = new SqliteStorage({ path: file });
  try {
    await storage.open();
  } catch (error) {
    // Leave nothing behind that a later init would mistake for a store.
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    throw error;
  }
  await storage.close();
}

export async function openStore(
  config: StoreConfig,
  principal: Principal = EMBEDDED_PRINCIPAL
): Promise<MemoryClient & { close(): Promise<void> }> {
  const file = databasePath(config);
  const history = historyProvider(config);
  if (!existsSync(file)) {
    throw new StoreUnavailableError('The directory is not a store', { reason: 'not_a_store' });
  }
  const service = new MemoryService(new SqliteStorage({ path: file }), history, {
    ...config.service,
    defaultHistoryPolicy: config.defaultHistoryPolicy ?? config.service?.defaultHistoryPolicy,
  });
  await service.open();
  return Object.assign(service.as(principal), { close: () => service.close() });
}
