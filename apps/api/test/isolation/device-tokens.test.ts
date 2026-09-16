/**
 * A student's phone stays inside its own organisation (EXPD-005).
 *
 * `participant_device.device_token_hash` is unique across the whole table, so
 * a hash identifies exactly one row no matter who is asking. That is what
 * makes it worth testing: the lookup would work perfectly well without any
 * tenant predicate, and a reviewer reading the code could easily think it had
 * to. It does not. `DeviceRepository` reads through `TenantRepository`, so a
 * token belonging to Riverbank Academy is invisible to Portside School even
 * with the right hash in hand.
 *
 * The same goes for withdrawing one. Ending a run must end that
 * organisation's phones, and only that organisation's.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type {
  ExpeditionSessionId,
  OrganisationId,
  ParticipantId,
} from '@explorer/shared-types';

import { hashOpaqueToken } from '../../src/auth/tokens.ts';
import { DeviceRepository } from '../../src/repositories/device-repository.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B, tenantFor } from '../support/organisations.ts';

/** A run of an expedition. The same id is used in both organisations on
 *  purpose: an id that collides must not be a way across the boundary. */
const RUN = 'run-0001' as ExpeditionSessionId;
const PARTICIPANT = 'participant-0001' as ParticipantId;

const IN_AN_HOUR = new Date('2026-03-01T10:00:00.000Z');
const NOW = new Date('2026-03-01T09:00:00.000Z');

/** Builds a device row as migration 0002 shapes one. */
function deviceRow(
  organisationId: OrganisationId,
  overrides: Partial<FakeRow> = {},
): FakeRow {
  return {
    id: `device-${organisationId.slice(0, 8)}`,
    organisation_id: organisationId,
    participant_id: PARTICIPANT,
    expedition_session_id: RUN,
    device_id: 'phone-1',
    device_token_hash: hashOpaqueToken(`token-for-${organisationId}`),
    issued_at: NOW,
    expires_at: IN_AN_HOUR,
    last_seen_at: null,
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

function bothOrganisations() {
  const db = new FakeDatabase();
  db.seed('participant_device', deviceRow(ORG_A), deviceRow(ORG_B));
  return {
    db,
    portside: new DeviceRepository(tenantFor(db, ORG_A)),
    riverbank: new DeviceRepository(tenantFor(db, ORG_B)),
  };
}

describe('looking a device token up', () => {
  test('the right hash in the right organisation finds the device', async () => {
    const { portside } = bothOrganisations();
    const found = await portside.findLiveDeviceByTokenHash(
      hashOpaqueToken(`token-for-${ORG_A}`),
      NOW,
    );

    assert.notEqual(found, null);
    assert.equal(found?.organisation_id, ORG_A);
  });

  test('the right hash in the wrong organisation finds nothing', async () => {
    const { portside } = bothOrganisations();
    const found = await portside.findLiveDeviceByTokenHash(
      hashOpaqueToken(`token-for-${ORG_B}`),
      NOW,
    );

    assert.equal(
      found,
      null,
      'a globally unique hash must still be looked up inside one organisation',
    );
  });

  test('a withdrawn device is not live, even in its own organisation', async () => {
    const db = new FakeDatabase();
    db.seed(
      'participant_device',
      deviceRow(ORG_A, { revoked_at: NOW, revoked_reason: 'logout' }),
    );

    const found = await new DeviceRepository(tenantFor(db, ORG_A)).findLiveDeviceByTokenHash(
      hashOpaqueToken(`token-for-${ORG_A}`),
      NOW,
    );

    assert.equal(found, null);
  });

  test('an expired device is not live', async () => {
    const { portside } = bothOrganisations();
    const found = await portside.findLiveDeviceByTokenHash(
      hashOpaqueToken(`token-for-${ORG_A}`),
      new Date(IN_AN_HOUR.getTime() + 1000),
    );

    assert.equal(found, null);
  });

  test('the lookup statement carries the organisation as a bound value', async () => {
    const { db, portside } = bothOrganisations();
    db.forgetStatements();

    await portside.findLiveDeviceByTokenHash(hashOpaqueToken('anything'), NOW);

    assert.match(db.lastStatement.text, /WHERE "organisation_id" = \$1/);
    assert.equal(db.lastStatement.values[0], ORG_A);
  });
});

describe('issuing a device token', () => {
  test('stamps the repository’s organisation on the new row', async () => {
    const { portside } = bothOrganisations();
    const issued = await portside.issueDeviceToken(
      {
        participantId: PARTICIPANT,
        expeditionSessionId: RUN,
        deviceId: 'phone-2',
        expiresAt: IN_AN_HOUR,
      },
      NOW,
    );

    assert.equal(issued.device.organisation_id, ORG_A);
  });

  test('stores only the hash, and hands the token back once', async () => {
    const { portside } = bothOrganisations();
    const issued = await portside.issueDeviceToken(
      {
        participantId: PARTICIPANT,
        expeditionSessionId: RUN,
        deviceId: 'phone-2',
        expiresAt: IN_AN_HOUR,
      },
      NOW,
    );

    assert.equal(issued.device.device_token_hash, hashOpaqueToken(issued.token));
    assert.notEqual(issued.device.device_token_hash, issued.token);
  });

  test('replacing a phone’s token does not withdraw another organisation’s', async () => {
    const { db, portside } = bothOrganisations();

    await portside.issueDeviceToken(
      {
        participantId: PARTICIPANT,
        expeditionSessionId: RUN,
        // The same participant and the same phone as the Riverbank row, which
        // is the worst case: only the organisation tells them apart.
        deviceId: 'phone-1',
        expiresAt: IN_AN_HOUR,
      },
      NOW,
    );

    const riverbank = db
      .rowsIn('participant_device')
      .find((row) => row['organisation_id'] === ORG_B);
    assert.equal(riverbank?.['revoked_at'], null);
  });
});

describe('withdrawing a device token', () => {
  test('cannot withdraw another organisation’s device by its id', async () => {
    const { db, portside } = bothOrganisations();
    const target = db
      .rowsIn('participant_device')
      .find((row) => row['organisation_id'] === ORG_B);

    assert.equal(await portside.revokeDevice(target?.['id'] as string, 'admin', NOW), false);
    assert.equal(
      db.rowsIn('participant_device').find((row) => row['organisation_id'] === ORG_B)?.[
        'revoked_at'
      ],
      null,
    );
  });

  test('ending a run ends this organisation’s phones only', async () => {
    const { db, portside } = bothOrganisations();

    assert.equal(await portside.revokeDevicesForSession(RUN, 'admin', NOW), 1);

    const rows = db.rowsIn('participant_device');
    assert.equal(rows.find((row) => row['organisation_id'] === ORG_A)?.['revoked_at'], NOW);
    assert.equal(rows.find((row) => row['organisation_id'] === ORG_B)?.['revoked_at'], null);
  });

  test('marking a device as seen cannot touch another organisation’s row', async () => {
    const { db, portside } = bothOrganisations();
    const target = db
      .rowsIn('participant_device')
      .find((row) => row['organisation_id'] === ORG_B);

    await portside.touchDeviceLastSeen(target?.['id'] as string, NOW);

    assert.equal(
      db.rowsIn('participant_device').find((row) => row['organisation_id'] === ORG_B)?.[
        'last_seen_at'
      ],
      null,
    );
  });
});

describe('the participant behind a device', () => {
  test('is read inside the organisation, never across it', async () => {
    const db = new FakeDatabase();
    db.seed(
      'participant',
      { id: PARTICIPANT, organisation_id: ORG_B, display_name: 'Ada' },
    );

    const portside = new DeviceRepository(tenantFor(db, ORG_A));
    assert.equal(await portside.findParticipant(PARTICIPANT), null);

    const riverbank = new DeviceRepository(tenantFor(db, ORG_B));
    assert.notEqual(await riverbank.findParticipant(PARTICIPANT), null);
  });

  test('the repository reports the organisation it is pinned to', () => {
    const { portside, riverbank } = bothOrganisations();

    assert.equal(portside.organisationId, ORG_A);
    assert.equal(riverbank.organisationId, ORG_B);
  });
});
