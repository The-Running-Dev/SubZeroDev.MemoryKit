import { resolve } from 'node:path';
import { ValidationFailedError, isPlainObject, type JsonValue } from '../model/index.ts';
import type { StorageConfig } from '../sdk/index.ts';

export const STORAGE_OPTIONS = {
  storage: { type: 'string' as const },
  'storage-plugin': { type: 'string' as const },
  'storage-options': { type: 'string' as const },
};
export function storageOptions(v: {
  storage?: string;
  'storage-plugin'?: string;
  'storage-options'?: string;
}): StorageConfig | undefined {
  if (v['storage-plugin'] !== undefined) {
    if (v.storage !== undefined)
      throw new ValidationFailedError('Choose --storage or --storage-plugin');
    let options: Record<string, JsonValue> | undefined;
    if (v['storage-options'] !== undefined) {
      try {
        const parsed: unknown = JSON.parse(v['storage-options']);
        if (!isPlainObject(parsed)) throw new Error();
        options = parsed as Record<string, JsonValue>;
      } catch {
        throw new ValidationFailedError('--storage-options must be a JSON object');
      }
    }
    return { provider: 'plugin', module: resolve(v['storage-plugin']), options };
  }
  if (v['storage-options'] !== undefined)
    throw new ValidationFailedError('--storage-options requires --storage-plugin');
  if (v.storage === undefined) return undefined;
  if (v.storage !== 'sqlite' && v.storage !== 'markdown')
    throw new ValidationFailedError('--storage must be sqlite or markdown');
  return { provider: v.storage };
}
export function storageArgs(config?: StorageConfig): string[] {
  if (!config) return [];
  return config.provider === 'plugin'
    ? ['--storage-plugin', config.module, '--storage-options', JSON.stringify(config.options ?? {})]
    : ['--storage', config.provider];
}
