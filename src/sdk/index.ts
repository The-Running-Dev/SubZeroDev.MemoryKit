import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDED_PRINCIPAL, type Principal } from '../access/index.ts';
import type { HistoryPolicy } from '../contracts/index.ts';
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

// Until history providers exist (S3, S4), a store runs without history.
function requireNoHistory(config: StoreConfig): void {
  const provider = config.history?.provider ?? 'none';
  if (provider !== 'none') {
    throw new UnsupportedError('This history provider is not available yet', {
      capability: `history.${provider}`,
    });
  }
}

export async function initStore(config: StoreConfig): Promise<void> {
  const file = databasePath(config);
  requireNoHistory(config);
  if (existsSync(file)) {
    throw new StoreUnavailableError('The directory is already a store', {
      reason: 'already_a_store',
    });
  }
  mkdirSync(config.path, { recursive: true });
  const storage = new SqliteStorage({ path: file });
  await storage.open();
  await storage.close();
}

export async function openStore(
  config: StoreConfig,
  principal: Principal = EMBEDDED_PRINCIPAL
): Promise<MemoryClient & { close(): Promise<void> }> {
  const file = databasePath(config);
  requireNoHistory(config);
  if (!existsSync(file)) {
    throw new StoreUnavailableError('The directory is not a store', { reason: 'not_a_store' });
  }
  const service = new MemoryService(new SqliteStorage({ path: file }), null, {
    ...config.service,
    defaultHistoryPolicy: config.defaultHistoryPolicy ?? config.service?.defaultHistoryPolicy,
  });
  await service.open();
  return Object.assign(service.as(principal), { close: () => service.close() });
}
