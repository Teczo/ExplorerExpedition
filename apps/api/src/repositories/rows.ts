/**
 * The shape of the rows the API reads (EXPD-004, EXPD-006).
 *
 * One interface per table, named after it, with the columns spelled exactly
 * as PostgreSQL spells them. Nothing is renamed to camel case on the way out
 * of the driver: a row is what the database returned, and the mapping into a
 * domain shape happens in the repository that owns it, once.
 *
 * Times are `Date`, because that is what `pg` gives back for `timestamptz`.
 */

import type {
  AuditAction,
  AuditActorKind,
  AuditChanges,
  AuditEntityType,
  MembershipRole,
} from '@explorer/shared-types';

/** Why a sign-in or a device stopped being usable. Matches the enum in 0002. */
export type AuthRevocationReason =
  | 'logout'
  | 'rotated'
  | 'reuse-detected'
  | 'password-changed'
  | 'membership-revoked'
  | 'admin';

/** A row of `app_user`. */
export interface AppUserRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string;
  readonly status: 'invited' | 'active' | 'suspended' | 'deactivated';
  readonly locale: string;
  readonly is_platform_admin: boolean;
  readonly last_seen_at: Date | null;
}

/** A row of `user_credential`. */
export interface UserCredentialRow {
  readonly user_id: string;
  readonly password_hash: string;
  readonly password_changed_at: Date;
}

/** A row of `membership`. */
export interface MembershipRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly user_id: string;
  readonly role: MembershipRole;
  readonly status: 'invited' | 'active' | 'revoked';
}

/** A row of `organisation`. */
export interface OrganisationRow {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly status: 'active' | 'suspended' | 'closed';
  readonly timezone: string;
  readonly locale: string;
}

/** A row of `auth_session`. */
export interface AuthSessionRow {
  readonly id: string;
  readonly user_id: string;
  readonly family_id: string;
  readonly refresh_token_hash: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly rotated_at: Date | null;
  readonly revoked_at: Date | null;
  readonly revoked_reason: AuthRevocationReason | null;
}

/** A row of `participant`. */
export interface ParticipantRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly expedition_session_id: string;
  readonly display_name: string;
  readonly status: 'invited' | 'joined' | 'active' | 'left' | 'removed';
  readonly device_id: string | null;
}

/** A row of `participant_device`. */
export interface ParticipantDeviceRow {
  readonly id: string;
  readonly organisation_id: string;
  readonly participant_id: string;
  readonly expedition_session_id: string;
  readonly device_id: string;
  readonly device_token_hash: string;
  readonly issued_at: Date;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
  readonly revoked_reason: AuthRevocationReason | null;
}

/**
 * A row of `audit_log` (EXPD-006).
 *
 * `sequence` is a `bigint`, and `pg` hands a bigint back as a string rather
 * than a number, because not every bigint fits in one. It is spelled as a
 * string here for that reason; `toAuditEntry` is where it becomes a number.
 *
 * Three columns are nullable, and each for its own reason.
 * `organisation_id` is NULL on an action that belongs to the platform rather
 * than to any organisation. The two actor ids are NULL on the kinds of actor
 * that have none: a `CHECK` constraint in 0001 means a `user` row always
 * carries a user id and a `participant` row always carries a participant id,
 * while a `system` or `service` row carries neither.
 */
export interface AuditLogRow {
  readonly id: string;
  readonly sequence: string;
  readonly organisation_id: string | null;
  readonly actor_kind: AuditActorKind;
  readonly actor_user_id: string | null;
  readonly actor_participant_id: string | null;
  readonly actor_label: string;
  readonly action: AuditAction;
  readonly entity_type: AuditEntityType;
  readonly entity_id: string | null;
  readonly changes: AuditChanges;
  readonly ip_address: string | null;
  readonly user_agent: string | null;
  readonly request_id: string | null;
  readonly occurred_at: Date;
}
