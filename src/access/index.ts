import { ForbiddenError, matchesPattern } from '../model/index.ts';
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

// The patterns under which the principal holds the permission. Permissions never imply
// one another.
export function permittedPatterns(p: Principal, permission: Permission): NamespacePattern[] {
  return p.grants
    .filter((grant) => grant.permissions.includes(permission))
    .map((grant) => grant.pattern);
}

// Throws Forbidden unless one grant holding the permission covers every namespace the
// pattern can match: "*" needs a "*" grant, and a subtree needs a subtree grant over it.
export function authorizePattern(
  p: Principal,
  permission: Permission,
  pattern: NamespacePattern
): void {
  const subtree = pattern.endsWith('/*');
  const base = subtree ? pattern.slice(0, -2) : pattern;
  const covered = permittedPatterns(p, permission).some(
    (grant) =>
      grant === '*' ||
      (pattern !== '*' && (!subtree || grant.endsWith('/*')) && matchesPattern(grant, base))
  );
  if (covered) return;
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
