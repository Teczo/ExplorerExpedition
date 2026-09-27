/**
 * Who may use the Studio (EXPD-024).
 *
 * The Studio is internal. It is for the Explorer team, and the Explorer team
 * is the set of platform support accounts: `app_user.is_platform_admin`. The
 * question is asked as a permission, never as a role, like everywhere else
 * (see `can` in `@explorer/shared-types`).
 *
 * This is the client's check. It decides what to draw. It is not the check
 * that protects anything: each endpoint the Studio calls makes its own on the
 * server.
 */

import { can, type Principal } from '@explorer/shared-types';

/** The permission that lets somebody into the Studio. */
export const STUDIO_PERMISSION = 'platform:administer';

/** Returns true when the principal is on the Explorer team. */
export function hasStudioAccess(principal: Principal): boolean {
  return principal.kind === 'user' && can(principal, STUDIO_PERMISSION);
}
