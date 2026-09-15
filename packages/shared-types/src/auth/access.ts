/**
 * Asking whether a principal may do something (EXPD-004).
 *
 * This is the only way code should ask. Comparing a role by hand —
 * `principal.orgRole === 'creator'` — spreads the rules across the codebase,
 * and the next person to change who may publish will miss one.
 */

import type { Permission } from './permissions.ts';
import { PERMISSIONS_BY_ROLE } from './permissions.ts';
import type { Principal } from './principal.ts';
import { rolesOf } from './principal.ts';

/** Returns true when the principal holds the permission. */
export function can(principal: Principal, permission: Permission): boolean {
  return rolesOf(principal).some((role) =>
    PERMISSIONS_BY_ROLE[role].includes(permission),
  );
}

/** Returns true when the principal holds every one of the permissions. */
export function canAll(
  principal: Principal,
  permissions: readonly Permission[],
): boolean {
  return permissions.every((permission) => can(principal, permission));
}

/** Returns true when the principal holds at least one of the permissions. */
export function canAny(
  principal: Principal,
  permissions: readonly Permission[],
): boolean {
  return permissions.some((permission) => can(principal, permission));
}

/**
 * Everything the principal may do, with no duplicates.
 *
 * Useful to a client that wants to hide a button it cannot use. It is never a
 * substitute for the check on the server.
 */
export function permissionsOf(principal: Principal): readonly Permission[] {
  const granted = new Set<Permission>();
  for (const role of rolesOf(principal)) {
    for (const permission of PERMISSIONS_BY_ROLE[role]) {
      granted.add(permission);
    }
  }
  return [...granted];
}
