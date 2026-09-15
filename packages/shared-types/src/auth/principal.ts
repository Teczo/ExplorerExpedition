/**
 * Who is making a request (EXPD-004).
 *
 * A principal is what the API knows about the caller once the token has been
 * checked. Every route, and every repository, takes one. Nothing downstream
 * reads a header or a token again.
 *
 * There are two kinds, because the platform has two kinds of caller.
 *
 *   A **user principal** is a person with an account, acting for one
 *   organisation. The same person acting for a second organisation is a
 *   different principal with a different token.
 *
 *   A **device principal** is a student's phone. It has no account, and it is
 *   pinned to one run of one expedition.
 */

import type { Id } from '../index.ts';
import type { OrgRole, Role } from './roles.ts';

/** The id of one organisation. */
export type OrganisationId = Id<'organisation'>;

/** The id of one account. */
export type UserId = Id<'user'>;

/** The id of one sign-in. */
export type AuthSessionId = Id<'authSession'>;

/** The id of one student in one run. */
export type ParticipantId = Id<'participant'>;

/** The id of one run of an expedition. */
export type ExpeditionSessionId = Id<'expeditionSession'>;

/** The id of one registered student phone. */
export type ParticipantDeviceId = Id<'participantDevice'>;

/**
 * A person with an account, acting for one organisation.
 *
 * `organisationId` is never null. A signed-in person who has not chosen an
 * organisation yet is not a principal: they hold a refresh token and nothing
 * else, and the API will not let them read a row until they ask for an access
 * token for a particular organisation. That is what "org-scoped auth" means
 * here — the organisation is fixed at the moment the token is minted, not
 * read off a header the caller controls.
 */
export interface UserPrincipal {
  readonly kind: 'user';
  readonly userId: UserId;
  /** The sign-in this token descends from, so it can be revoked. */
  readonly authSessionId: AuthSessionId;
  /** The organisation this token acts for. */
  readonly organisationId: OrganisationId;
  /** What the person may do inside that organisation. */
  readonly orgRole: OrgRole;
  /**
   * True when the account is a platform support account.
   *
   * A platform admin is still scoped to one organisation at a time. The flag
   * widens what they may do inside it; it does not let one request read two
   * organisations at once.
   */
  readonly isPlatformAdmin: boolean;
}

/**
 * A student's phone.
 *
 * It is pinned to one participant, in one run, in one organisation. Those
 * three come off the stored device record, never off the request.
 */
export interface DevicePrincipal {
  readonly kind: 'device';
  readonly participantId: ParticipantId;
  readonly participantDeviceId: ParticipantDeviceId;
  readonly expeditionSessionId: ExpeditionSessionId;
  readonly organisationId: OrganisationId;
}

/** Whoever is making the request. */
export type Principal = UserPrincipal | DevicePrincipal;

/** Returns true when the principal is a person with an account. */
export function isUserPrincipal(principal: Principal): principal is UserPrincipal {
  return principal.kind === 'user';
}

/** Returns true when the principal is a student's phone. */
export function isDevicePrincipal(principal: Principal): principal is DevicePrincipal {
  return principal.kind === 'device';
}

/**
 * The roles a principal holds.
 *
 * A platform admin holds two: the organisation role their membership gives
 * them, and `platform-admin`. Holding both matters, because a platform admin
 * supporting a school should be able to do everything a member of that school
 * can do, plus the platform work — not a different set.
 */
export function rolesOf(principal: Principal): readonly Role[] {
  if (principal.kind === 'device') {
    return ['student-device'];
  }

  return principal.isPlatformAdmin
    ? [principal.orgRole, 'platform-admin']
    : [principal.orgRole];
}

/**
 * A short line naming the principal, for a log or an audit entry.
 *
 * It carries no name and no email on purpose. What may be written down about
 * a child is EXPD-071, and an id is enough to join back to the row.
 */
export function describePrincipal(principal: Principal): string {
  return principal.kind === 'user'
    ? `user ${principal.userId} in organisation ${principal.organisationId}`
    : `device ${principal.participantDeviceId} for participant ${principal.participantId}`;
}
