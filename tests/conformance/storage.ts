import type { StoreConfig, StorageConfig } from '../../src/sdk/index.ts';
import { storageArgs } from '../../src/cli/storage.ts';
export const configuredStorage = new Map<string, StorageConfig>();
export const storeConfig = (path: string): StoreConfig => ({
  path,
  storage: configuredStorage.get(path),
});
export const storeArgs = (path: string) => storageArgs(configuredStorage.get(path));
