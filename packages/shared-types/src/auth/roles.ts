/**
 * Who somebody is, and what that lets them do (EXPD-004).
 *
 * The platform has two separate ideas of a role, and keeping them apart is
 * the whole point of this file.
 *
 *   A *membership role* is what the database stores. `membership.role` is one
 *   of five values chosen by EXPD-003 to describe a job inside a school:
 *   owner, admin, creator, teacher, member.
 *
 *   A *platform role* is what the code checks. It is the vocabulary the API,
 *   the Studio and the student app all speak.
 *
 * They are not the same list, and they should not be. Two different
 * membership roles — an owner and an admin — can do exactly the same things,
 * and a student device has no membership row at all. `ORG_ROLE_BY_MEMBERSHIP_ROLE`
 * below is the one place the two are joined up.
 */

/**
 * The membership roles `membership.role` stores.
 *
 * Copied from the `membership_role` enum in
 * `apps/api/db/migrations/0001_core_data_model.sql`, in the same order.
 */
export const MEMBERSHIP_ROLES = [
  'owner',
  'admin',
  'creator',
  'teacher',
  'member',
] as const;

/** One of the values `membership.role` holds. */
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/**
 * The roles the code checks against.
 *
 * `platform-admin` is the only one that is not an organisation role. It comes
 * from `app_user.is_platform_admin` and belongs to no organisation, which is
 * why it is listed here rather than in `ORG_ROLES` below.
 */
export const ROLES = [
  /** Supports the platform itself. The only role that crosses tenants. */
  'platform-admin',
  /** Runs one organisation: its people, its plan and everything it owns. */
  'org-admin',
  /** Builds expeditions and mission types for one organisation. */
  'creator',
  /** Runs an expedition with a class. Does not author one. */
  'facilitator',
  /** Signed in, but granted nothing yet. */
  'org-member',
  /** A student's phone. Has no account, and can only touch its own run. */
  'student-device',
] as const;

/** One of the roles the code checks against. */
export type Role = (typeof ROLES)[number];

/** The roles somebody can hold *inside* one organisation. */
export const ORG_ROLES = [
  'org-admin',
  'creator',
  'facilitator',
  'org-member',
] as const;

/** A role held inside one organisation. */
export type OrgRole = (typeof ORG_ROLES)[number];

/** Returns true when the value is one of the roles the code checks. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Returns true when the value is a role held inside one organisation. */
export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === 'string' && (ORG_ROLES as readonly string[]).includes(value);
}

/** Returns true when the value is one of the stored membership roles. */
export function isMembershipRole(value: unknown): value is MembershipRole {
  return (
    typeof value === 'string' && (MEMBERSHIP_ROLES as readonly string[]).includes(value)
  );
}

/**
 * What each stored membership role means to the code.
 *
 * `owner` and `admin` both mean `org-admin`. The difference between them is
 * that an organisation must keep exactly one active owner — EXPD-003 enforces
 * that with a partial unique index — and it is about who cannot be removed,
 * not about who may do what.
 *
 * `member` maps to `org-member`, which grants nothing. It is the column's
 * default, so it is what a half-finished invite ends up with, and the safe
 * reading of a half-finished invite is that no decision has been made yet.
 */
export const ORG_ROLE_BY_MEMBERSHIP_ROLE: Readonly<Record<MembershipRole, OrgRole>> = {
  owner: 'org-admin',
  admin: 'org-admin',
  creator: 'creator',
  teacher: 'facilitator',
  member: 'org-member',
};

/** Turns a stored `membership.role` into the role the code checks. */
export function toOrgRole(membershipRole: MembershipRole): OrgRole {
  return ORG_ROLE_BY_MEMBERSHIP_ROLE[membershipRole];
}
