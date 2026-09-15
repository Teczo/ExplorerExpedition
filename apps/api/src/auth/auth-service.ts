/**
 * Signing in, staying signed in, and signing out (EXPD-004).
 *
 * The service is where the pieces meet: the password hashing in
 * `password.ts`, the signing in `tokens.ts`, and the repository layer in
 * `../db`. It holds no Express types, so it can be driven from a test, a
 * script, or the MCP server (EXPD-074) as easily as from a route.
 *
 * ## How a sign-in works
 *
 * Signing in is two steps, not one, and the split is what makes auth
 * org-scoped.
 *
 *   1. `signIn` checks the email and password. It gives back a refresh token
 *      and the list of organisations the person may act for. It does not give
 *      back an access token, because there is nothing yet to say which
 *      organisation the token would be for.
 *
 *   2. `accessTokenFor` takes that refresh token and one organisation, checks
 *      the membership again, and mints an access token that names it.
 *
 * Somebody who works for two schools therefore holds one sign-in and asks for
 * an access token per school. The organisation is baked into the token when
 * it is minted, so no later request can change it by sending a header. That
 * is the whole reason for the shape.
 *
 * A person who belongs to exactly one organisation is the common case, and
 * `signIn` mints the access token for them as part of the same call, so the
 * two-step design costs a single-school teacher nothing.
 */

import { randomUUID } from 'node:crypto';

import {
  isOrgRole,
  toOrgRole,
  type DevicePrincipal,
  type ExpeditionSessionId,
  type OrganisationId,
  type OrgRole,
  type ParticipantDeviceId,
  type ParticipantId,
  type UserId,
  type UserPrincipal,
} from '@explorer/shared-types';

import type { AuthConfig } from '../config/auth-config.ts';
import type {
  AccountRepository,
  MembershipWithOrganisation,
} from '../repositories/account-repository.ts';
import type { DeviceRepository } from '../repositories/device-repository.ts';
import type { AppUserRow } from '../repositories/rows.ts';
import { AuthError } from './errors.ts';
import {
  checkPassword,
  hashPassword,
  needsRehash,
  spendVerificationTime,
  verifyPassword,
} from './password.ts';
import {
  hashOpaqueToken,
  mintOpaqueToken,
  signAccessToken,
  verifyAccessToken,
} from './tokens.ts';

/** One organisation the signed-in person may act for. */
export interface AvailableOrganisation {
  readonly organisationId: OrganisationId;
  readonly name: string;
  readonly slug: string;
  readonly orgRole: OrgRole;
}

/** An access token, and when it stops working. */
export interface AccessToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly organisationId: OrganisationId;
  readonly orgRole: OrgRole;
}

/**
 * An access token for a student's phone.
 *
 * It carries no organisation role, because a phone has no membership. What it
 * may do comes from the `student-device` role, which is the same for every
 * phone, so there is nothing to put in the token.
 */
export interface DeviceAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
  readonly organisationId: OrganisationId;
  readonly participantId: ParticipantId;
  readonly expeditionSessionId: ExpeditionSessionId;
}

/** What a successful sign-in gives back. */
export interface SignInResult {
  readonly userId: UserId;
  readonly displayName: string;
  readonly isPlatformAdmin: boolean;
  /** Present it to `refresh` or `accessTokenFor`. Shown once. */
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  /** Every organisation this person may ask for a token for. */
  readonly organisations: readonly AvailableOrganisation[];
  /**
   * Minted here when the person belongs to exactly one organisation, so the
   * common case is one round trip. Null when there is a choice to make.
   */
  readonly accessToken: AccessToken | null;
}

/** What a refresh gives back. The refresh token is always a new one. */
export interface RefreshResult {
  readonly userId: UserId;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: Date;
  readonly organisations: readonly AvailableOrganisation[];
}

/** Where a sign-in came from, so a person can recognise their own devices. */
export interface RequestOrigin {
  readonly userAgent?: string | null;
  readonly ipAddress?: string | null;
}

/** What the service needs to run. */
export interface AuthServiceDeps {
  readonly config: AuthConfig;
  readonly accounts: AccountRepository;
  /**
   * Builds a device repository for one organisation.
   *
   * A factory rather than a repository, because a device repository is pinned
   * to an organisation and the service does not know which until it has read
   * the token.
   */
  readonly devicesFor: (organisationId: OrganisationId) => DeviceRepository;
  /** Overridable so a test can control the clock. */
  readonly now?: () => Date;
}

/** Signing in, staying signed in, and signing out. */
export class AuthService {
  readonly #config: AuthConfig;
  readonly #accounts: AccountRepository;
  readonly #devicesFor: (organisationId: OrganisationId) => DeviceRepository;
  readonly #now: () => Date;

  constructor(deps: AuthServiceDeps) {
    this.#config = deps.config;
    this.#accounts = deps.accounts;
    this.#devicesFor = deps.devicesFor;
    this.#now = deps.now ?? (() => new Date());
  }

  // --- Signing in ---------------------------------------------------------

  /**
   * Checks an email and password, and starts a sign-in.
   *
   * Every way of failing answers `bad-credentials` and takes about the same
   * time. An account that does not exist still spends a hash — see
   * `spendVerificationTime` — because answering "no such account" quickly
   * tells anybody who asks which addresses are real.
   */
  async signIn(
    email: string,
    password: string,
    origin: RequestOrigin = {},
  ): Promise<SignInResult> {
    const now = this.#now();
    const user = await this.#accounts.findUserByEmail(email);

    if (user === null) {
      await spendVerificationTime();
      throw new AuthError('bad-credentials', `no account for ${email}`);
    }

    const credential = await this.#accounts.findCredential(user.id as UserId);
    if (credential === null) {
      await spendVerificationTime();
      throw new AuthError('bad-credentials', `account ${user.id} has no password set`);
    }

    const matched = await verifyPassword(password, credential.password_hash);
    if (!matched) {
      throw new AuthError('bad-credentials', `wrong password for account ${user.id}`);
    }

    // Only now that the password is known to be right is it safe to say the
    // account is suspended. Saying it earlier would confirm the address.
    this.#assertUserCanSignIn(user);

    // The password was proved, so a hash written at an older cost can be
    // quietly written back at the current one.
    if (needsRehash(credential.password_hash)) {
      await this.#accounts.setPassword(
        user.id as UserId,
        await hashPassword(password),
        credential.password_changed_at,
      );
    }

    await this.#accounts.touchUserLastSeen(user.id as UserId, now);

    const memberships = await this.#accounts.listActiveMemberships(user.id as UserId);
    const refresh = await this.#startSession(user.id as UserId, null, origin, now);

    return {
      userId: user.id as UserId,
      displayName: user.display_name,
      isPlatformAdmin: user.is_platform_admin,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt,
      organisations: memberships.map(toAvailableOrganisation),
      accessToken:
        memberships.length === 1 && memberships[0] !== undefined
          ? this.#mintAccessToken(user, memberships[0], now)
          : null,
    };
  }

  /**
   * Mints an access token for one organisation.
   *
   * The membership is checked here, on every call, rather than being trusted
   * from the sign-in. That is what bounds how long a revoked membership keeps
   * working: one access token's life, and no longer.
   */
  async accessTokenFor(
    refreshToken: string,
    organisationId: OrganisationId,
  ): Promise<AccessToken> {
    const now = this.#now();
    const session = await this.#requireLiveSession(refreshToken, now);
    const user = await this.#requireSignedInUser(session.user_id as UserId);

    const membership = await this.#accounts.findActiveMembership(
      user.id as UserId,
      organisationId,
    );
    if (membership === null) {
      throw new AuthError(
        'not-a-member',
        `account ${user.id} has no active membership of organisation ${organisationId}`,
      );
    }

    return this.#mintAccessToken(user, membership, now);
  }

  /**
   * Exchanges a refresh token for a new one.
   *
   * The old token stops working the moment this succeeds. If it is ever
   * presented again, two people hold it — one of them having copied it — and
   * the whole family is withdrawn rather than guessing which of the two is
   * the thief.
   */
  async refresh(
    refreshToken: string,
    origin: RequestOrigin = {},
  ): Promise<RefreshResult> {
    const now = this.#now();
    const session = await this.#requireLiveSession(refreshToken, now);
    const user = await this.#requireSignedInUser(session.user_id as UserId);

    await this.#accounts.markAuthSessionRotated(session.id, now);
    const next = await this.#startSession(
      user.id as UserId,
      session.family_id,
      origin,
      now,
    );
    const memberships = await this.#accounts.listActiveMemberships(user.id as UserId);

    return {
      userId: user.id as UserId,
      refreshToken: next.token,
      refreshTokenExpiresAt: next.expiresAt,
      organisations: memberships.map(toAvailableOrganisation),
    };
  }

  /**
   * Signs out.
   *
   * Withdraws the whole family, so signing out on a phone that has refreshed
   * fifty times since signing in really does end that sign-in. Other devices
   * are untouched: they are their own families.
   *
   * It does not fail on a token it does not recognise. There is nothing to do
   * about one, and answering differently would say whether it was real.
   */
  async signOut(refreshToken: string): Promise<void> {
    const session = await this.#accounts.findAuthSessionByTokenHash(
      hashOpaqueToken(refreshToken),
    );
    if (session === null) {
      return;
    }
    await this.#accounts.revokeFamily(session.family_id, 'logout', this.#now());
  }

  // --- Passwords ----------------------------------------------------------

  /**
   * Sets an account's password and ends every sign-in it had.
   *
   * Used by onboarding, by an invite being accepted, and by a password reset.
   * It does not check an old password: whoever calls it has already
   * established that the person is allowed to, and the ways of establishing
   * that differ.
   */
  async setPassword(userId: UserId, password: string): Promise<void> {
    const problem = checkPassword(password);
    if (problem !== null) {
      throw new AuthError('weak-password', `password rejected: ${problem}`);
    }

    const now = this.#now();
    await this.#accounts.setPassword(userId, await hashPassword(password), now);
    await this.#accounts.revokeAllForUser(userId, 'password-changed', now);
  }

  // --- Checking a token on the way in -------------------------------------

  /**
   * Turns an access token into the principal that made the request.
   *
   * The organisation and the role come out of the signed token, not out of
   * the request, so nothing a caller sends can widen what they reach.
   *
   * The account is not read back. That is deliberate, and it is the trade the
   * short lifetime pays for: an account suspended a minute ago keeps working
   * until its current access token runs out, and in exchange every request
   * costs no query. Anything that has to stop instantly — ending a run,
   * withdrawing a device — is checked against a row and not against a token.
   */
  authenticateUser(accessToken: string): UserPrincipal {
    const result = verifyAccessToken(
      this.#config.signingKey,
      accessToken,
      'user',
      this.#now(),
    );
    if (!result.ok) {
      throw new AuthError('bad-token', `access token rejected: ${result.problem}`);
    }

    const { claims } = result;
    const role = claims['role'];
    const sid = claims['sid'];
    if (typeof role !== 'string' || typeof sid !== 'string' || !isOrgRole(role)) {
      throw new AuthError('bad-token', 'access token is missing its role or sign-in');
    }

    return {
      kind: 'user',
      userId: claims.sub as UserId,
      authSessionId: sid as UserPrincipal['authSessionId'],
      organisationId: claims.org as OrganisationId,
      orgRole: role,
      isPlatformAdmin: claims['pa'] === true,
    };
  }

  // --- Student devices ----------------------------------------------------

  /**
   * Mints an access token for a student's phone.
   *
   * The device token itself is issued by EXPD-018 at the moment of joining.
   * This turns one into the short-lived token the phone then sends on each
   * request, in the same shape as a staff token so that one middleware
   * handles both.
   */
  async deviceAccessToken(
    organisationId: OrganisationId,
    deviceToken: string,
  ): Promise<DeviceAccessToken> {
    const now = this.#now();
    const devices = this.#devicesFor(organisationId);

    const device = await devices.findLiveDeviceByTokenHash(
      hashOpaqueToken(deviceToken),
      now,
    );
    if (device === null) {
      throw new AuthError('session-ended', 'device token is unknown, withdrawn or expired');
    }

    await devices.touchDeviceLastSeen(device.id, now);

    const token = signAccessToken(
      this.#config.signingKey,
      {
        sub: device.participant_id,
        aud: 'device',
        org: organisationId,
        ses: device.expedition_session_id,
        dev: device.id,
      },
      this.#config.lifetimes.accessSeconds,
      now,
    );

    return {
      token,
      expiresAt: new Date(now.getTime() + this.#config.lifetimes.accessSeconds * 1000),
      organisationId,
      participantId: device.participant_id as ParticipantId,
      expeditionSessionId: device.expedition_session_id as ExpeditionSessionId,
    };
  }

  /** Turns a device access token into the principal that made the request. */
  authenticateDevice(accessToken: string): DevicePrincipal {
    const result = verifyAccessToken(
      this.#config.signingKey,
      accessToken,
      'device',
      this.#now(),
    );
    if (!result.ok) {
      throw new AuthError('bad-token', `device token rejected: ${result.problem}`);
    }

    const { claims } = result;
    const runId = claims['ses'];
    const deviceId = claims['dev'];
    if (typeof runId !== 'string' || typeof deviceId !== 'string') {
      throw new AuthError('bad-token', 'device token is missing its run or device');
    }

    return {
      kind: 'device',
      participantId: claims.sub as ParticipantId,
      participantDeviceId: deviceId as ParticipantDeviceId,
      expeditionSessionId: runId as ExpeditionSessionId,
      organisationId: claims.org as OrganisationId,
    };
  }

  // --- Internals ----------------------------------------------------------

  #mintAccessToken(
    user: AppUserRow,
    membership: MembershipWithOrganisation,
    now: Date,
  ): AccessToken {
    const orgRole = toOrgRole(membership.membership.role);
    const organisationId = membership.organisation.id as OrganisationId;

    const token = signAccessToken(
      this.#config.signingKey,
      {
        sub: user.id,
        aud: 'user',
        org: organisationId,
        role: orgRole,
        // Short, because every byte is sent on every request.
        sid: membership.membership.id,
        pa: user.is_platform_admin,
      },
      this.#config.lifetimes.accessSeconds,
      now,
    );

    return {
      token,
      expiresAt: new Date(now.getTime() + this.#config.lifetimes.accessSeconds * 1000),
      organisationId,
      orgRole,
    };
  }

  /** Mints a refresh token and records the sign-in it belongs to. */
  async #startSession(
    userId: UserId,
    familyId: string | null,
    origin: RequestOrigin,
    now: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const token = mintOpaqueToken();
    const expiresAt = new Date(
      now.getTime() + this.#config.lifetimes.refreshSeconds * 1000,
    );

    await this.#accounts.createAuthSession({
      userId,
      // A fresh sign-in starts its own family. The id is generated here rather
      // than by the database, so that the row can be written in one statement
      // with the family already set.
      familyId: familyId ?? randomUUID(),
      refreshTokenHash: hashOpaqueToken(token),
      expiresAt,
      userAgent: origin.userAgent ?? null,
      ipAddress: origin.ipAddress ?? null,
    });

    return { token, expiresAt };
  }

  /**
   * Reads the sign-in a refresh token belongs to, and refuses a dead one.
   *
   * The reuse check lives here: a token already exchanged means two holders,
   * and the family goes.
   */
  async #requireLiveSession(
    refreshToken: string,
    now: Date,
  ): Promise<{ id: string; user_id: string; family_id: string }> {
    const session = await this.#accounts.findAuthSessionByTokenHash(
      hashOpaqueToken(refreshToken),
    );
    if (session === null) {
      throw new AuthError('session-ended', 'refresh token is not one we issued');
    }

    if (session.rotated_at !== null) {
      await this.#accounts.revokeFamily(session.family_id, 'reuse-detected', now);
      throw new AuthError(
        'session-ended',
        `refresh token for sign-in ${session.id} was presented twice; family withdrawn`,
      );
    }
    if (session.revoked_at !== null) {
      throw new AuthError(
        'session-ended',
        `sign-in ${session.id} was withdrawn: ${session.revoked_reason}`,
      );
    }
    if (session.expires_at.getTime() <= now.getTime()) {
      throw new AuthError('session-ended', `sign-in ${session.id} has expired`);
    }

    return session;
  }

  async #requireSignedInUser(userId: UserId): Promise<AppUserRow> {
    const user = await this.#accounts.findUserById(userId);
    if (user === null) {
      throw new AuthError('session-ended', `account ${userId} no longer exists`);
    }
    this.#assertUserCanSignIn(user);
    return user;
  }

  #assertUserCanSignIn(user: AppUserRow): void {
    if (user.status !== 'active') {
      throw new AuthError(
        'account-unavailable',
        `account ${user.id} is ${user.status}`,
      );
    }
  }
}

function toAvailableOrganisation(
  entry: MembershipWithOrganisation,
): AvailableOrganisation {
  return {
    organisationId: entry.organisation.id as OrganisationId,
    name: entry.organisation.name,
    slug: entry.organisation.slug,
    orgRole: toOrgRole(entry.membership.role),
  };
}
