import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StorageProvider, TokenStore } from '../contracts/index.ts';
import {
  StoreUnavailableError,
  UnsupportedError,
  ValidationFailedError,
  isPlainObject,
  type JsonValue,
} from '../model/index.ts';

export type StorageConfig =
  | { provider: 'sqlite' }
  | { provider: 'markdown'; searchIndex?: boolean }
  | { provider: 'plugin'; module: string; options?: Record<string, JsonValue> };
export interface StoragePluginContext {
  path: string;
  initialize: boolean;
  options: Record<string, JsonValue>;
}
export interface StoragePlugin {
  /** Factory only; MemoryKit owns storage.open/close. Tokens share its lifecycle. */
  createStorage(
    context: StoragePluginContext
  ): Promise<{ storage: StorageProvider; tokens: TokenStore }>;
}
export const STORE_MARKER = 'memorykit.store.json';
export function validateStorageConfig(value: unknown): asserts value is StorageConfig {
  const json = (v: unknown, ancestors = new Set<unknown>()): boolean => {
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if ((!Array.isArray(v) && !isPlainObject(v)) || ancestors.has(v)) return false;
    const next = new Set(ancestors).add(v);
    return Object.values(v).every((child) => json(child, next));
  };
  if (
    !isPlainObject(value) ||
    !['sqlite', 'markdown', 'plugin'].includes(value.provider as string) ||
    Object.keys(value).some(
      (k) =>
        !(value.provider === 'plugin' ? ['provider', 'module', 'options'] : value.provider === 'markdown' ? ['provider','searchIndex'] : ['provider']).includes(
          k
        )
    ) ||
    (value.provider === 'markdown' && value.searchIndex !== undefined && typeof value.searchIndex !== 'boolean') ||
    (value.provider === 'plugin' &&
      (typeof value.module !== 'string' ||
        !isAbsolute(value.module) ||
        (value.options !== undefined && (!isPlainObject(value.options) || !json(value.options)))))
  )
    throw new ValidationFailedError('Invalid storage configuration');
}
export function storageConfig(path: string, configured?: StorageConfig): StorageConfig {
  if (configured !== undefined) validateStorageConfig(configured);
  let found: string | undefined;
  try {
    if (existsSync(join(path, STORE_MARKER))) {
      const marker = JSON.parse(readFileSync(join(path, STORE_MARKER), 'utf8')) as {
        version: number;
        provider: string;
      };
      if (marker.version !== 1 || !['sqlite', 'markdown', 'plugin'].includes(marker.provider))
        throw new Error();
      found = marker.provider;
    } else if (existsSync(join(path, 'memory.db'))) found = 'sqlite';
  } catch {
    throw new StoreUnavailableError('Invalid store marker', { reason: 'not_a_store' });
  }
  if (configured && found && configured.provider !== found)
    throw new StoreUnavailableError('Storage provider does not match the store', {
      reason: 'provider_mismatch',
    });
  if (found === 'plugin' && !configured)
    throw new ValidationFailedError(
      'External storage requires explicit trusted plugin configuration'
    );
  return configured ?? { provider: (found ?? 'sqlite') as 'sqlite' | 'markdown' };
}
export function storeExists(path: string): boolean {
  return existsSync(join(path, STORE_MARKER)) || existsSync(join(path, 'memory.db'));
}
export async function createStorage(
  path: string,
  configured: StorageConfig | undefined,
  initialize: boolean
) {
  const config = storageConfig(path, configured);
  if (config.provider === 'sqlite') {
    const { SqliteStorage } = await import('../storage-sqlite/index.ts');
    const storage = new SqliteStorage({ path: join(path, 'memory.db') });
    return { storage, tokens: storage as TokenStore, config };
  }
  if (config.provider === 'markdown') {
    const { MarkdownStorage } = await import('../storage-markdown/index.ts');
    const storage = new MarkdownStorage({ path: join(path, 'markdown'), searchIndex: config.searchIndex });
    return { storage, tokens: storage as TokenStore, config };
  }
  if (
    config.provider !== 'plugin' ||
    typeof config.module !== 'string' ||
    !isAbsolute(config.module)
  )
    throw new ValidationFailedError('Storage plugin module must be an absolute file path');
  const plugin = (await import(pathToFileURL(config.module).href)) as StoragePlugin;
  if (typeof plugin.createStorage !== 'function')
    throw new UnsupportedError('Storage module must export createStorage', {
      capability: 'storage.plugin',
    });
  const result = await plugin.createStorage({ path, initialize, options: config.options ?? {} });
  if (
    !result?.storage?.descriptor?.contractVersions?.includes(1) ||
    !result.tokens ||
    typeof result.tokens.verify !== 'function'
  )
    throw new UnsupportedError('Storage plugin does not implement contract version 1', {
      capability: 'storage.plugin',
    });
  return { ...result, config };
}
