import type { NamespacePattern, Permission } from '../model/index.ts';

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
