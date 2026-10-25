import {
  ForbiddenError,
  isNamespacePattern,
  isPlainObject,
  matchesPattern,
  ValidationFailedError,
} from '../model/index.ts';
import type { Namespace, NamespacePattern, Permission } from '../model/index.ts';

export interface Grant {
  pattern: NamespacePattern;
  permissions: Permission[];
}
export interface Principal {
  id: string;
  profile: 'embedded' | 'local' | 'remote';
  grants: Grant[];
}

export const EMBEDDED_PRINCIPAL: Principal = Object.freeze({
  id: 'embedded',
  profile: 'embedded',
  grants: [
    { pattern: '*', permissions: ['read', 'write', 'tombstone', 'history', 'purge', 'admin'] },
  ],
}) as Principal;

export const PERMISSIONS: readonly Permission[] = [
  'read',
  'write',
  'tombstone',
  'history',
  'purge',
  'admin',
];
const PROFILES: readonly Principal['profile'][] = ['embedded', 'local', 'remote'];
const MAX_PRINCIPAL_ID_LENGTH = 256;

function invalidPrincipal(field: string, reason: string): ValidationFailedError {
  return new ValidationFailedError(`Invalid principal ${field}: ${reason}`, {
    field: `principal.${field}`,
    reason,
  });
}

// Checks a host-supplied principal and returns a frozen copy, so a later change to the
// host's object cannot widen what an open client may do.
export function validatePrincipal(value: unknown): Principal {
  if (!isPlainObject(value)) throw invalidPrincipal('id', 'not_an_object');
  const { id, profile, grants } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_PRINCIPAL_ID_LENGTH) {
    throw invalidPrincipal('id', 'invalid');
  }
  if (!PROFILES.includes(profile as Principal['profile'])) {
    throw invalidPrincipal('profile', 'unsupported');
  }
  if (!Array.isArray(grants)) throw invalidPrincipal('grants', 'not_a_list');
  const copied = grants.map((grant: unknown, index) => {
    if (!isPlainObject(grant)) throw invalidPrincipal(`grants[${index}]`, 'not_an_object');
    const { pattern, permissions } = grant;
    if (typeof pattern !== 'string' || !isNamespacePattern(pattern)) {
      throw invalidPrincipal(`grants[${index}].pattern`, 'invalid_pattern');
    }
    if (
      !Array.isArray(permissions) ||
      !permissions.every((permission) => PERMISSIONS.includes(permission as Permission))
    ) {
      throw invalidPrincipal(`grants[${index}].permissions`, 'unknown_permission');
    }
    return Object.freeze({
      pattern,
      permissions: Object.freeze([...permissions]) as Permission[],
    });
  });
  return Object.freeze({
    id,
    profile: profile as Principal['profile'],
    grants: Object.freeze(copied) as Grant[],
  });
}

// The patterns under which the principal holds the permission. Permissions never imply
// one another.
export function permittedPatterns(p: Principal, permission: Permission): NamespacePattern[] {
  return p.grants
    .filter((grant) => grant.permissions.includes(permission))
    .map((grant) => grant.pattern);
}

// Whether every namespace the inner pattern can match is matched by the outer one: "*" is
// covered only by "*", and a subtree only by a subtree over it.
export function patternCovers(outer: NamespacePattern, inner: NamespacePattern): boolean {
  if (outer === '*') return true;
  if (inner === '*') return false;
  const subtree = inner.endsWith('/*');
  return (
    (!subtree || outer.endsWith('/*')) &&
    matchesPattern(outer, subtree ? inner.slice(0, -2) : inner)
  );
}

// Throws Forbidden unless one grant holding the permission covers every namespace the
// pattern can match.
export function authorizePattern(
  p: Principal,
  permission: Permission,
  pattern: NamespacePattern
): void {
  if (permittedPatterns(p, permission).some((grant) => patternCovers(grant, pattern))) return;
  throw new ForbiddenError('The namespace or permission is not granted', {
    namespace: pattern,
    permission,
  });
}

// Throws Forbidden unless one of the principal's grants gives the permission on the namespace.
export function authorize(p: Principal, permission: Permission, ns: Namespace): void {
  if (permittedPatterns(p, permission).some((pattern) => matchesPattern(pattern, ns))) return;
  throw new ForbiddenError('The namespace or permission is not granted', {
    namespace: ns,
    permission,
  });
}

// Grants from a space-separated scope claim. Only "mk:<permission>:<pattern>" items count;
// others (openid, profile) and malformed ones grant nothing.
export function parseScopeClaim(scope: string): Grant[] {
  const grants: Grant[] = [];
  for (const item of typeof scope === 'string' ? scope.split(/\s+/) : []) {
    const match = /^mk:([a-z]+):(.+)$/.exec(item);
    if (!match) continue;
    const permission = match[1] as Permission;
    const pattern = match[2]!;
    if (!PERMISSIONS.includes(permission) || !isNamespacePattern(pattern)) continue;
    grants.push({ pattern, permissions: [permission] });
  }
  return grants;
}

// What a token may do: each requested permission on the narrower of its pattern and a ceiling
// pattern holding the same permission. Patterns that only partly overlap grant nothing.
export function intersectGrants(requested: Grant[], ceiling: Grant[]): Grant[] {
  const byPattern = new Map<NamespacePattern, Set<Permission>>();
  for (const grant of requested) {
    for (const permission of grant.permissions) {
      for (const limit of ceiling) {
        if (!limit.permissions.includes(permission)) continue;
        const pattern = patternCovers(limit.pattern, grant.pattern)
          ? grant.pattern
          : patternCovers(grant.pattern, limit.pattern)
            ? limit.pattern
            : undefined;
        if (pattern === undefined) continue;
        if (!byPattern.has(pattern)) byPattern.set(pattern, new Set());
        byPattern.get(pattern)!.add(permission);
      }
    }
  }
  return [...byPattern].map(([pattern, permissions]) => ({
    pattern,
    permissions: PERMISSIONS.filter((permission) => permissions.has(permission)),
  }));
}
