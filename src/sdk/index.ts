import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDED_PRINCIPAL, type Principal } from '../access/index.ts';
import type { HistoryPolicy, HistoryProvider, TokenStore } from '../contracts/index.ts';
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
export const HISTORY_REPOSITORY = 'history.git';

function databasePath(config: StoreConfig): string {
  if (typeof config?.path !== 'string' || config.path.length === 0) {
    throw new ValidationFailedError('Invalid path: required', {
      field: 'path',
      reason: 'required',
    });
  }
  return join(config.path, DATABASE_FILE);
}

// Git is the default. Each provider's module loads only when chosen, so a store without Git
// history never loads the Git provider.
async function historyProvider(config: StoreConfig): Promise<HistoryProvider | null> {
  const history = config.history ?? { provider: 'git' };
  switch (history.provider) {
    case 'none':
      return null;
    case 'memory': {
      const { MemoryHistory } = await import('../history-memory/index.ts');
      return new MemoryHistory();
    }
    case 'git': {
      const { GitHistory } = await import('../history-git/index.ts');
      return new GitHistory({
        repository: history.repository ?? join(config.path, HISTORY_REPOSITORY),
      });
    }
    default:
      throw new UnsupportedError('This history provider is not supported', {
        capability: `history.${String((history as { provider: unknown }).provider)}`,
      });
  }
}

export async function initStore(config: StoreConfig): Promise<void> {
  const file = databasePath(config);
  const history = await historyProvider(config);
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
  // Creates the history repository; without git it is created on a later open.
  await history?.open();
  await history?.close();
}

function existingDatabase(config: StoreConfig): string {
  const file = databasePath(config);
  if (!existsSync(file)) {
    throw new StoreUnavailableError('The directory is not a store', { reason: 'not_a_store' });
  }
  return file;
}

export interface OpenService {
  service: MemoryService;
  tokens: TokenStore;
  close(): Promise<void>;
}

// The service with its token store, for hosts that serve several principals.
export async function openService(config: StoreConfig): Promise<OpenService> {
  const file = existingDatabase(config);
  const history = await historyProvider(config);
  const storage = new SqliteStorage({ path: file });
  const service = new MemoryService(storage, history, {
    ...config.service,
    defaultHistoryPolicy: config.defaultHistoryPolicy ?? config.service?.defaultHistoryPolicy,
  });
  await service.open();
  return { service, tokens: storage, close: () => service.close() };
}

export async function openStore(
  config: StoreConfig,
  principal: Principal = EMBEDDED_PRINCIPAL
): Promise<MemoryClient & { close(): Promise<void> }> {
  const { service, close } = await openService(config);
  let client: MemoryClient;
  try {
    client = service.as(principal);
  } catch (error) {
    await close();
    throw error;
  }
  return Object.assign(client, { close });
}

// The token store alone, for issuing and revoking tokens without opening history.
export async function openTokenStore(
  config: StoreConfig
): Promise<TokenStore & { close(): Promise<void> }> {
  const storage = new SqliteStorage({ path: existingDatabase(config) });
  await storage.open();
  return {
    issue: (principalId, grants) => storage.issue(principalId, grants),
    verify: (secret) => storage.verify(secret),
    revoke: (tokenId) => storage.revoke(tokenId),
    list: () => storage.list(),
    close: () => storage.close(),
  };
}

export { connect, type ConnectOptions } from './connect.ts';
