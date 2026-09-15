/**
 * The shape of the rows auth reads (EXPD-004).
 *
 * One interface per table, named after it, with the columns spelled exactly
 * as PostgreSQL spells them. Nothing is renamed to camel case on the way out
 * of the driver: a row is what the database returned, and the mapping into a
 * domain shape happens in the repository that owns it, once.
 *
 * Times are `Date`, because that is what `pg` gives back for `timestamptz`.
 */

import type { MembershipRole } from '@explorer/shared-types';

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
