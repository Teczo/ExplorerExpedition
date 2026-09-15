/**
 * What each role is allowed to do (EXPD-004).
 *
 * A permission is a coarse verb against a kind of thing: `expedition:publish`,
 * `submission:review`. Code asks `can(principal, 'expedition:publish')` and
 * never asks `principal.role === 'creator'`, so that changing who may publish
 * is an edit to the table below rather than a hunt through the routes.
 *
 * A permission answers *what kind of thing* somebody may do. It never answers
 * *which rows*. "May this facilitator review submissions?" is a permission.
 * "Is this submission one of theirs?" is tenant isolation, and that is the
 * repository layer's job (`apps/api/src/db`). Both have to pass.
 *
 * This is the starting vocabulary, and it is deliberately coarse. Later
 * tickets that add endpoints add the permissions those endpoints need.
 */

import type { Role } from './roles.ts';

/** Everything a role can be granted. */
export const PERMISSIONS = [
  // --- The organisation itself ---
  /** Read the organisation's own record: name, timezone, settings. */
  'organisation:read',
  /** Change it. */
  'organisation:write',

  // --- People ---
  /** See who else is in the organisation. */
  'member:read',
  /** Invite somebody, change their role, or revoke them. */
  'member:write',

  // --- Money (EXPD-068, EXPD-069) ---
  /** See the plan and its limits. */
  'subscription:read',
  /** Change the plan. */
  'subscription:write',

  // --- Authoring (EXPD-017, EXPD-031) ---
  /** Read expeditions and their revisions. */
  'expedition:read',
  /** Create or edit a draft revision. */
  'expedition:write',
  /** Publish a revision, so a class can play it. */
  'expedition:publish',
  /** Archive or delete an expedition. */
  'expedition:delete',
  /** Read mission types and templates, the platform-wide ones included. */
  'mission-type:read',
  /** Build or edit the organisation's own mission types (EXPD-025). */
  'mission-type:write',

  // --- Running a class (EXPD-019, EXPD-055, EXPD-058) ---
  /** Read runs of an expedition. */
  'session:read',
  /** Schedule a run, or change one that has not started. */
  'session:write',
  /** Start, pause, resume, end, or override a run in Director Mode. */
  'session:control',

  // --- The students in a run (EXPD-018) ---
  /** Read participants and teams. */
  'participant:read',
  /** Move somebody between teams, or remove them from a run. */
  'participant:write',

  // --- Playing (EXPD-020) ---
  /** Read mission attempts and submissions. */
  'attempt:read',
  /** Open an attempt and submit to it. A student device does this. */
  'attempt:write',
  /** Accept or reject a submission that needs a teacher (EXPD-056). */
  'submission:review',

  // --- Files (EXPD-021, EXPD-030) ---
  /** Read media assets. */
  'media:read',
  /** Ask for a signed upload URL. */
  'media:write',

  // --- The record (EXPD-006) ---
  /** Read the organisation's audit log. */
  'audit:read',

  // --- Platform support (EXPD-070) ---
  /** Read and act inside any organisation. Platform admins only. */
  'platform:administer',
] as const;

/** One thing a role can be granted. */
export type Permission = (typeof PERMISSIONS)[number];

/** Returns true when the value is a permission this file lists. */
export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Everything a creator may do. Named because a facilitator gets a slice of it
 * and `org-admin` gets all of it.
 */
const CREATOR_PERMISSIONS = [
  'organisation:read',
  'member:read',
  'expedition:read',
  'expedition:write',
  'expedition:publish',
  'expedition:delete',
  'mission-type:read',
  'mission-type:write',
  'session:read',
  'session:write',
  'session:control',
  'participant:read',
  'participant:write',
  'attempt:read',
  'submission:review',
  'media:read',
  'media:write',
] as const satisfies readonly Permission[];

/**
 * Everything a facilitator may do.
 *
 * A facilitator runs a class with an expedition somebody else built. They can
 * read an expedition and control a run of it, but they cannot edit, publish
 * or delete one, and they cannot build a mission type.
 */
const FACILITATOR_PERMISSIONS = [
  'organisation:read',
  'member:read',
  'expedition:read',
  'mission-type:read',
  'session:read',
  'session:write',
  'session:control',
  'participant:read',
  'participant:write',
  'attempt:read',
  'submission:review',
  'media:read',
  'media:write',
] as const satisfies readonly Permission[];

/**
 * Everything a student's phone may do.
 *
 * This is the narrowest set on purpose, and it is still not the whole check.
 * `attempt:write` says a device may submit; it does not say which attempt,
 * and a device is scoped to one run and one team by the row checks in
 * EXPD-018 and EXPD-020.
 *
 * There is no `participant:write`: a student cannot move themselves between
 * teams. There is no `media:read`: the app is given the URLs it needs.
 */
const STUDENT_DEVICE_PERMISSIONS = [
  'session:read',
  'participant:read',
  'attempt:read',
  'attempt:write',
  'media:write',
] as const satisfies readonly Permission[];

/** Joins permission lists together, keeping each permission once. */
function union(...lists: readonly (readonly Permission[])[]): readonly Permission[] {
  return [...new Set(lists.flat())];
}

/**
 * What each role may do.
 *
 * `platform-admin` holds every permission there is. That is the definition of
 * the role, and it is why `app_user.is_platform_admin` is guarded and logged.
 *
 * `org-admin` is a creator who also runs the organisation: the whole creator
 * set, plus the people, the plan and the audit log.
 *
 * `org-member` holds nothing. Somebody whose invite has not been given a real
 * role yet can sign in, and that is all.
 */
export const PERMISSIONS_BY_ROLE: Readonly<Record<Role, readonly Permission[]>> = {
  'platform-admin': PERMISSIONS,
  'org-admin': union(CREATOR_PERMISSIONS, [
    'organisation:write',
    'member:write',
    'subscription:read',
    'subscription:write',
    'audit:read',
  ]),
  creator: CREATOR_PERMISSIONS,
  facilitator: FACILITATOR_PERMISSIONS,
  'org-member': [],
  'student-device': STUDENT_DEVICE_PERMISSIONS,
};

/** Returns true when the role holds the permission. */
export function roleHasPermission(role: Role, permission: Permission): boolean {
  return PERMISSIONS_BY_ROLE[role].includes(permission);
}
