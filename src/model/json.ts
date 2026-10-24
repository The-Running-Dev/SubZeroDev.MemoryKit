import { createHash } from 'node:crypto';
import type { JsonValue } from './types.ts';

const MAX_DEPTH = 32;

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// True when the value survives a JSON round trip unchanged: no undefined, functions,
// non-finite numbers or class instances.
export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > MAX_DEPTH) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  if (isPlainObject(value))
    return Object.values(value).every((item) => isJsonValue(item, depth + 1));
  return false;
}

// JSON with object keys sorted at every level, so equal values give equal text.
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    // fromEntries defines own properties, so a "__proto__" key is kept rather than
    // replacing the prototype.
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .filter((key) => value[key] !== undefined)
        .map((key) => [key, sortKeys(value[key])])
    );
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
