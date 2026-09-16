/**
 * Which organisation a token is minted for (EXPD-005).
 *
 * A token that names an organisation is only worth anything if nobody can get
 * one for an organisation they do not belong to. `AuthService.accessTokenFor`
 * is the single door: it re-reads the membership on every call and mints a
 * token naming the organisation it found.
 *
 * These tests drive the real service over a scripted database, so the
 * membership answer is the test's to control. The statements it ran are
 * checked too — a membership lookup that forgot to filter by organisation
 * would return the wrong row long before any repository got involved.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { OrganisationId, UserId } from '@explorer/shared-types';

import { AuthService } from '../../src/auth/auth-service.ts';
import { AuthError } from '../../src/auth/errors.ts';
import { hashPassword } from '../../src/auth/password.ts';
import { hashOpaqueToken, signingKey, verifyAccessToken } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { tenantRepository } from '../../src/db/tenant-repository.ts';
import { globalRepository } from '../../src/db/global-repository.ts';
import { AccountRepository } from '../../src/repositories/account-repository.ts';
import { DeviceRepository } from '../../src/repositories/device-repository.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { RecordingDatabase } from '../support/recording-database.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';
import type { Queryable } from '../../src/db/queryable.ts';

const NOW = new Date('2026-03-01T09:00:00.000Z');
const USER = 'user-0001' as UserId;
const PASSWORD = 'a-long-enough-password';

const CONFIG: AuthConfig = {
  signingKey: signingKey('a'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

/** A row of `app_user`, active and not a platform admin. */
const USER_ROW: FakeRow = {
  id: USER,
  email: 'teacher@portside.example',
  display_name: 'Ada Teacher',
  status: 'active',
  locale: 'en-GB',
  is_platform_admin: false,
  last_seen_at: null,
};

/** A live sign-in the refresh token below belongs to. */
const REFRESH_TOKEN = 'refresh-token-value';
const SESSION_ROW: FakeRow = {
  id: 'session-0001',
  user_id: USER,
  family_id: 'family-0001',
  refresh_token_hash: hashOpaqueToken(REFRESH_TOKEN),
  issued_at: NOW,
  expires_at: new Date(NOW.getTime() + 60 * 60 * 1000),
  rotated_at: null,
  revoked_at: null,
  revoked_reason: null,
};

/** One row of the membership join, aliased the way the query aliases it. */
function membershipRow(organisationId: OrganisationId, role: string): FakeRow {
  return {
    m_id: `membership-${organisationId.slice(0, 8)}`,
    m_organisation_id: organisationId,
    m_user_id: USER,
    m_role: role,
    m_status: 'active',
    o_id: organisationId,
    o_name: organisationId === ORG_A ? 'Portside School' : 'Riverbank Academy',
    o_slug: organisationId === ORG_A ? 'portside' : 'riverbank',
    o_status: 'active',
    o_timezone: 'Europe/London',
    o_locale: 'en-GB',
  };
}

/** Builds the service over a database whose answers a test controls. */
function serviceOver(db: Queryable): AuthService {
  return new AuthService({
    config: CONFIG,
    accounts: new AccountRepository(db, globalRepository(db)),
    devicesFor: (organisationId) =>
      new DeviceRepository(tenantRepository(db, { organisationId })),
    now: () => NOW,
  });
}

/** A database that answers as if the person belongs to `memberships`. */
function databaseFor(memberships: readonly FakeRow[], passwordHash = ''): RecordingDatabase {
  return new RecordingDatabase()
    .answer('FROM "app_user"', [USER_ROW])
    .answer('FROM "user_credential"', [
      { user_id: USER, password_hash: passwordHash, password_changed_at: NOW },
    ])
    .answer('FROM "auth_session"', [SESSION_ROW])
    .answer('INSERT INTO "auth_session"', [SESSION_ROW])
    .answer('FROM "membership" m', memberships);
}

describe('asking for an access token for an organisation', () => {
  test('is refused when there is no active membership of it', async () => {
    const db = databaseFor([]);

    await assert.rejects(
      () => serviceOver(db).accessTokenFor(REFRESH_TOKEN, ORG_B),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal(error.failure, 'not-a-member');
        assert.equal(error.status, 403);
        return true;
      },
    );
  });

  test('the membership is looked up for the organisation that was asked for', async () => {
    const db = databaseFor([]);

    await assert.rejects(() => serviceOver(db).accessTokenFor(REFRESH_TOKEN, ORG_B), AuthError);

    const lookup = db.statementContaining('FROM "membership" m');
    assert.match(lookup.text, /m\.organisation_id = \$2/);
    assert.deepEqual(lookup.values, [USER, ORG_B]);
  });

  test('a membership of one organisation does not open another', async () => {
    // The person really is a member of Portside School. The database answers
    // the Riverbank lookup with nothing, which is what the real query would
    // do, and the service must not fall back on what it knows.
    const db = new RecordingDatabase()
      .answer('FROM "app_user"', [USER_ROW])
      .answer('FROM "auth_session"', [SESSION_ROW])
      .answer('FROM "membership" m', []);

    await assert.rejects(
      () => serviceOver(db).accessTokenFor(REFRESH_TOKEN, ORG_B),
      AuthError,
    );
  });

  test('the token that comes back names the organisation that was checked', async () => {
    const db = databaseFor([membershipRow(ORG_A, 'teacher')]);
    const token = await serviceOver(db).accessTokenFor(REFRESH_TOKEN, ORG_A);

    assert.equal(token.organisationId, ORG_A);
    assert.equal(token.orgRole, 'facilitator');

    const checked = verifyAccessToken(CONFIG.signingKey, token.token, 'user', NOW);
    assert.equal(checked.ok && checked.claims.org, ORG_A);
  });

  test('the principal read back from it acts for that organisation and no other', async () => {
    const db = databaseFor([membershipRow(ORG_A, 'creator')]);
    const service = serviceOver(db);
    const token = await service.accessTokenFor(REFRESH_TOKEN, ORG_A);

    const principal = service.authenticateUser(token.token);
    assert.equal(principal.kind, 'user');
    assert.equal(principal.organisationId, ORG_A);
    assert.equal(principal.orgRole, 'creator');
  });

  test('the same sign-in can hold a token per organisation, and they stay apart', async () => {
    const service = serviceOver(databaseFor([membershipRow(ORG_A, 'teacher')]));
    const forPortside = await service.accessTokenFor(REFRESH_TOKEN, ORG_A);

    const other = serviceOver(databaseFor([membershipRow(ORG_B, 'owner')]));
    const forRiverbank = await other.accessTokenFor(REFRESH_TOKEN, ORG_B);

    assert.equal(service.authenticateUser(forPortside.token).organisationId, ORG_A);
    assert.equal(other.authenticateUser(forRiverbank.token).organisationId, ORG_B);
    assert.equal(forPortside.orgRole, 'facilitator');
    assert.equal(forRiverbank.orgRole, 'org-admin');
  });
});

describe('signing in', () => {
  test('mints a token straight away only when there is one organisation to pick', async () => {
    const db = databaseFor([membershipRow(ORG_A, 'teacher')], await hashPassword(PASSWORD));
    const result = await serviceOver(db).signIn(USER_ROW['email'] as string, PASSWORD);

    assert.notEqual(result.accessToken, null);
    assert.equal(result.accessToken?.organisationId, ORG_A);
  });

  test('makes somebody who works for two schools choose one', async () => {
    const db = databaseFor(
      [membershipRow(ORG_A, 'teacher'), membershipRow(ORG_B, 'teacher')],
      await hashPassword(PASSWORD),
    );
    const result = await serviceOver(db).signIn(USER_ROW['email'] as string, PASSWORD);

    assert.equal(
      result.accessToken,
      null,
      'no token can be minted until the person says which organisation it is for',
    );
    assert.deepEqual(
      result.organisations.map((organisation) => organisation.organisationId),
      [ORG_A, ORG_B],
    );
  });

  test('the refresh token alone reads no rows: it names no organisation', async () => {
    const db = databaseFor(
      [membershipRow(ORG_A, 'teacher'), membershipRow(ORG_B, 'teacher')],
      await hashPassword(PASSWORD),
    );
    const result = await serviceOver(db).signIn(USER_ROW['email'] as string, PASSWORD);

    assert.equal(typeof result.refreshToken, 'string');
    assert.equal(result.accessToken, null);
  });
});

describe('a student’s phone', () => {
  const DEVICE_TOKEN = 'device-token-value';

  /** A database holding one device row, owned by `organisationId`. */
  function withDeviceIn(organisationId: OrganisationId): FakeDatabase {
    const db = new FakeDatabase();
    db.seed('participant_device', {
      id: 'device-0001',
      organisation_id: organisationId,
      participant_id: 'participant-0001',
      expedition_session_id: 'run-0001',
      device_id: 'phone-1',
      device_token_hash: hashOpaqueToken(DEVICE_TOKEN),
      issued_at: NOW,
      expires_at: new Date(NOW.getTime() + 60 * 60 * 1000),
      last_seen_at: null,
      revoked_at: null,
      revoked_reason: null,
    });
    return db;
  }

  test('gets a token naming the organisation its device row belongs to', async () => {
    const service = serviceOver(withDeviceIn(ORG_A));
    const token = await service.deviceAccessToken(ORG_A, DEVICE_TOKEN);

    assert.equal(token.organisationId, ORG_A);
    assert.equal(service.authenticateDevice(token.token).organisationId, ORG_A);
  });

  test('cannot present its token to another organisation', async () => {
    const service = serviceOver(withDeviceIn(ORG_A));

    await assert.rejects(
      () => service.deviceAccessToken(ORG_B, DEVICE_TOKEN),
      (error: unknown) => {
        assert.ok(error instanceof AuthError);
        assert.equal(error.failure, 'session-ended');
        return true;
      },
    );
  });

  test('the device lookup is scoped to the organisation that was named', async () => {
    const db = withDeviceIn(ORG_A);
    db.forgetStatements();

    await assert.rejects(() => serviceOver(db).deviceAccessToken(ORG_B, DEVICE_TOKEN), AuthError);

    const lookup = db.statements[0];
    assert.match(lookup?.text ?? '', /FROM "participant_device" WHERE "organisation_id" = \$1/);
    assert.equal(lookup?.values[0], ORG_B);
  });

  test('a device principal is never mistaken for a member of staff', async () => {
    const service = serviceOver(withDeviceIn(ORG_A));
    const token = await service.deviceAccessToken(ORG_A, DEVICE_TOKEN);

    assert.throws(() => service.authenticateUser(token.token), (error: unknown) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.failure, 'bad-token');
      return true;
    });
  });
});
