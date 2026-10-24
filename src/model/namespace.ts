import { ValidationFailedError } from './errors.ts';
import type { Namespace, NamespacePattern } from './types.ts';

const SEGMENT = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_SEGMENTS = 8;

function isNamespace(value: string): boolean {
  const segments = value.split('/');
  return segments.length <= MAX_SEGMENTS && segments.every((segment) => SEGMENT.test(segment));
}

export function parseNamespace(value: string): Namespace {
  if (typeof value !== 'string' || !isNamespace(value)) {
    throw new ValidationFailedError('Invalid namespace', { field: 'namespace' });
  }
  return value;
}

export function isNamespacePattern(value: string): boolean {
  if (value === '*') return true;
  return isNamespace(value.endsWith('/*') ? value.slice(0, -2) : value);
}

export function matchesPattern(pattern: NamespacePattern, ns: Namespace): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith('/*')) {
    const base = pattern.slice(0, -2);
    return ns === base || ns.startsWith(base + '/');
  }
  return ns === pattern;
}
