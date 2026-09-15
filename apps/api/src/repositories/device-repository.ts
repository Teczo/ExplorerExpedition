/**
 * Student devices (EXPD-004).
 *
 * Unlike `AccountRepository`, everything here is tenant scoped, and that is
 * the point of the file: it is what the repository layer looks like for the
 * other twenty-four tables. It never writes `organisation_id = ...` and it
 * never could — `TenantRepository` adds the predicate to every statement it
 * builds, and the organisation was fixed when the repository was made.
 *
 * Handing a device token out at the moment a student joins is EXPD-018, which
 * owns join codes. This file owns issuing one for a participant that already
 * exists, checking one that comes back, and withdrawing one.
 */

import type {
  ExpeditionSessionId,
  OrganisationId,
  ParticipantId,
} from '@explorer/shared-types';

import type { TenantRepository } from '../db/index.ts';
import { hashOpaqueToken, mintOpaqueToken } from '../auth/tokens.ts';
import type {
  AuthRevocationReason,
  ParticipantDeviceRow,
  ParticipantRow,
} from './rows.ts';

/** A freshly issued device token, and the row that will check it. */
export interface IssuedDeviceToken {
  /**
   * The token itself. Returned once, at the moment it is minted, and never
   * readable again: only its hash is stored.
   */
  readonly token: string;
  readonly device: ParticipantDeviceRow;
}

/** What issuing a device token needs. */
export interface IssueDeviceTokenInput {
  readonly participantId: ParticipantId;
  readonly expeditionSessionId: ExpeditionSessionId;
  /** Identifies the phone. Never a person (EXPD-071). */
  readonly deviceId: string;
  readonly expiresAt: Date;
}

/** Student devices, and the participants they belong to. */
export class DeviceRepository {
  readonly #tenant: TenantRepository;

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  /** The organisation every statement here is filtered by. */
  get organisationId(): OrganisationId {
    return this.#tenant.organisationId;
  }

  /**
   * Mints a device token for a participant and stores its hash.
   *
   * A second token for the same phone replaces the first: migration 0002 has
   * a unique index over the live rows, so the old one is withdrawn here
   * before the new one goes in. A student reopening the app gets one working
   * token, not a growing pile of them.
   */
  async issueDeviceToken(
    input: IssueDeviceTokenInput,
    now: Date = new Date(),
  ): Promise<IssuedDeviceToken> {
    await this.#tenant.update<ParticipantDeviceRow>(
      'participant_device',
      { participant_id: input.participantId, device_id: input.deviceId, revoked_at: null },
      { revoked_at: now, revoked_reason: 'rotated' },
    );

    const token = mintOpaqueToken();
    const device = await this.#tenant.insert<ParticipantDeviceRow>(
      'participant_device',
      {
        participant_id: input.participantId,
        expedition_session_id: input.expeditionSessionId,
        device_id: input.deviceId,
        device_token_hash: hashOpaqueToken(token),
        expires_at: input.expiresAt,
      },
    );

    return { token, device };
  }

  /**
   * Finds the live device record a token belongs to, or null.
   *
   * "Live" means not withdrawn and not expired. Both are checked in the
   * statement rather than afterwards, so an expired token cannot be
   * accidentally used by a caller that forgot to look.
   *
   * Because this is a tenant-scoped read, a token that belongs to another
   * organisation matches nothing here, even though the hash is unique across
   * the whole table. That is the isolation rule doing its job: the service
   * finds the organisation first, from the token's own claims, and then looks
   * inside it.
   */
  async findLiveDeviceByTokenHash(
    tokenHash: string,
    now: Date = new Date(),
  ): Promise<ParticipantDeviceRow | null> {
    const device = await this.#tenant.findOne<ParticipantDeviceRow>(
      'participant_device',
      { where: { device_token_hash: tokenHash, revoked_at: null } },
    );

    if (device === null || device.expires_at.getTime() <= now.getTime()) {
      return null;
    }
    return device;
  }

  /** Reads the participant a device belongs to. */
  async findParticipant(participantId: ParticipantId): Promise<ParticipantRow | null> {
    return this.#tenant.findById<ParticipantRow>('participant', participantId);
  }

  /** Records that a device was seen, so Director Mode can show who is online. */
  async touchDeviceLastSeen(deviceId: string, at: Date): Promise<void> {
    await this.#tenant.updateById<ParticipantDeviceRow>('participant_device', deviceId, {
      last_seen_at: at,
    });
  }

  /** Withdraws one device token. */
  async revokeDevice(
    deviceId: string,
    reason: AuthRevocationReason,
    at: Date = new Date(),
  ): Promise<boolean> {
    const rows = await this.#tenant.update<ParticipantDeviceRow>(
      'participant_device',
      { id: deviceId, revoked_at: null },
      { revoked_at: at, revoked_reason: reason },
    );
    return rows.length > 0;
  }

  /**
   * Withdraws every device token in one run.
   *
   * What ending a run should do: once the class is over, the phones that were
   * playing it stop being able to submit anything.
   */
  async revokeDevicesForSession(
    expeditionSessionId: ExpeditionSessionId,
    reason: AuthRevocationReason,
    at: Date = new Date(),
  ): Promise<number> {
    const rows = await this.#tenant.update<ParticipantDeviceRow>(
      'participant_device',
      { expedition_session_id: expeditionSessionId, revoked_at: null },
      { revoked_at: at, revoked_reason: reason },
    );
    return rows.length;
  }
}
