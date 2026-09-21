/**
 * The four tables a run's students live in (EXPD-018).
 *
 * `expedition_session` is the run, `participant` is a student in it, `team` is
 * a group of them and `team_member` is the row that puts the two together.
 * Every call goes through a `TenantRepository`, so the organisation predicate
 * is on every statement whether this file remembers it or not (EXPD-004).
 * There is no method here that takes an organisation, because there is
 * nowhere for one to come from but the token — or, for a student joining, the
 * code they typed, which `JoinCodeDirectory` has already turned into one.
 *
 * Two of migration 0001's indexes decide almost every shape below, so they
 * are worth repeating here:
 *
 *   `team_member_one_team_per_participant_idx` counts only the rows whose
 *   `left_at` is NULL, so a student is on one team at a time and moving means
 *   ending one membership before starting another.
 *
 *   `team_member` is also `UNIQUE (team_id, participant_id)` with no
 *   predicate, so a student who leaves a team and comes back to it has to
 *   reuse their old row. `rejoinTeam` is that, and it is why moving is not
 *   simply an insert.
 */

import type { ParticipantStatus, TeamStatus } from '@explorer/shared-types';

import type { Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type {
  ExpeditionSessionRow,
  ExpeditionVersionRow,
  ParticipantRow,
  TeamMemberRow,
  TeamRow,
} from '../repositories/rows.ts';

/** What a student joining a run needs. */
export interface NewParticipant {
  readonly expeditionSessionId: string;
  readonly displayName: string;
  readonly deviceId: string;
  readonly status: ParticipantStatus;
}

/** What a new team needs. */
export interface NewTeam {
  readonly expeditionSessionId: string;
  readonly name: string;
}

/** What goes on a membership row when somebody joins a team. */
export interface TeamMembership {
  readonly role: string | null;
  readonly isLeader: boolean;
}

/** The runs, students and teams of one organisation. */
export class ParticipationRepository {
  readonly #tenant: TenantRepository;

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  /** The same repository against a different connection, such as a transaction. */
  withConnection(db: Queryable): ParticipationRepository {
    return new ParticipationRepository(this.#tenant.withConnection(db));
  }

  // --- The run ------------------------------------------------------------

  /** One run, or null when this organisation has no such row. */
  async findSession(
    id: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionSessionRow | null> {
    return this.#tenant.findOne<ExpeditionSessionRow>('expedition_session', {
      where: { id },
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  /** Writes a new join code onto a run. */
  async setJoinCode(id: string, joinCode: string): Promise<ExpeditionSessionRow | null> {
    return this.#tenant.updateById<ExpeditionSessionRow>('expedition_session', id, {
      join_code: joinCode,
    });
  }

  /**
   * The revision a run is pinned to, document and all.
   *
   * Read for one reason: `rules.teams` is what the size and team limits are.
   * It is a large read for a small answer, and it is still the right one —
   * the alternative is a copy of the limits on the run, and a copy is a thing
   * that can disagree with the document it was copied from.
   */
  async findPinnedVersion(
    expeditionVersionId: string,
  ): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.findById<ExpeditionVersionRow>(
      'expedition_version',
      expeditionVersionId,
    );
  }

  // --- Students -----------------------------------------------------------

  /** Every student in one run, in the order they arrived. */
  async listParticipants(expeditionSessionId: string): Promise<ParticipantRow[]> {
    return this.#tenant.find<ParticipantRow>('participant', {
      where: { expedition_session_id: expeditionSessionId },
      orderBy: [
        { column: 'joined_at', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
    });
  }

  /** One student in one run, or null. */
  async findParticipant(
    expeditionSessionId: string,
    participantId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ParticipantRow | null> {
    return this.#tenant.findOne<ParticipantRow>('participant', {
      where: { id: participantId, expedition_session_id: expeditionSessionId },
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  /**
   * The student a phone already is in this run, or null.
   *
   * What makes reopening the app land a student back where they were rather
   * than beside a second copy of themselves. `device_id` identifies the
   * phone and never the person (EXPD-071), and it is only ever matched inside
   * one run.
   */
  async findParticipantByDevice(
    expeditionSessionId: string,
    deviceId: string,
  ): Promise<ParticipantRow | null> {
    return this.#tenant.findOne<ParticipantRow>('participant', {
      where: { expedition_session_id: expeditionSessionId, device_id: deviceId },
      orderBy: [{ column: 'joined_at', direction: 'desc' }],
    });
  }

  /** How many students in a run hold one of these statuses. */
  async countParticipants(
    expeditionSessionId: string,
    statuses: readonly ParticipantStatus[],
  ): Promise<number> {
    return this.#tenant.count('participant', {
      expedition_session_id: expeditionSessionId,
      status: statuses as readonly string[],
    });
  }

  /** Adds a student to a run. */
  async insertParticipant(input: NewParticipant): Promise<ParticipantRow> {
    return this.#tenant.insert<ParticipantRow>('participant', {
      expedition_session_id: input.expeditionSessionId,
      display_name: input.displayName,
      device_id: input.deviceId,
      status: input.status,
    });
  }

  /** Changes a student's name, status, or the phone they are on. */
  async updateParticipant(
    participantId: string,
    patch: {
      readonly displayName?: string;
      readonly status?: ParticipantStatus;
      readonly deviceId?: string;
      readonly leftAt?: Date | null;
    },
  ): Promise<ParticipantRow | null> {
    const values: Record<string, string | Date | null> = {};
    if (patch.displayName !== undefined) {
      values['display_name'] = patch.displayName;
    }
    if (patch.status !== undefined) {
      values['status'] = patch.status;
    }
    if (patch.deviceId !== undefined) {
      values['device_id'] = patch.deviceId;
    }
    if (patch.leftAt !== undefined) {
      values['left_at'] = patch.leftAt;
    }
    return this.#tenant.updateById<ParticipantRow>('participant', participantId, values);
  }

  // --- Teams --------------------------------------------------------------

  /** Every team in one run, oldest first. */
  async listTeams(expeditionSessionId: string): Promise<TeamRow[]> {
    return this.#tenant.find<TeamRow>('team', {
      where: { expedition_session_id: expeditionSessionId },
      orderBy: [
        { column: 'created_at', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
    });
  }

  /** One team in one run, or null. */
  async findTeam(
    expeditionSessionId: string,
    teamId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<TeamRow | null> {
    return this.#tenant.findOne<TeamRow>('team', {
      where: { id: teamId, expedition_session_id: expeditionSessionId },
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  /** How many teams in a run hold one of these statuses. */
  async countTeams(
    expeditionSessionId: string,
    statuses: readonly TeamStatus[],
  ): Promise<number> {
    return this.#tenant.count('team', {
      expedition_session_id: expeditionSessionId,
      status: statuses as readonly string[],
    });
  }

  /** Adds a team to a run. */
  async insertTeam(input: NewTeam): Promise<TeamRow> {
    return this.#tenant.insert<TeamRow>('team', {
      expedition_session_id: input.expeditionSessionId,
      name: input.name,
      status: 'forming',
    });
  }

  // --- Who is on which team -----------------------------------------------

  /**
   * Every live membership in a run.
   *
   * Read through the teams rather than through a join, because `team_member`
   * carries no `expedition_session_id`: a membership belongs to a team, and
   * the team belongs to the run. An empty list of teams reads nothing at all,
   * which `buildFilter` already turns into a statement matching nothing.
   */
  async listMembers(teamIds: readonly string[]): Promise<TeamMemberRow[]> {
    if (teamIds.length === 0) {
      return [];
    }
    return this.#tenant.find<TeamMemberRow>('team_member', {
      where: { team_id: teamIds, left_at: null },
      orderBy: [
        { column: 'joined_at', direction: 'asc' },
        { column: 'id', direction: 'asc' },
      ],
    });
  }

  /** The team a student is on now, or null when they are on none. */
  async findLiveMembership(participantId: string): Promise<TeamMemberRow | null> {
    return this.#tenant.findOne<TeamMemberRow>('team_member', {
      where: { participant_id: participantId, left_at: null },
    });
  }

  /** A student's membership of one team, live or long over. */
  async findMembership(
    teamId: string,
    participantId: string,
  ): Promise<TeamMemberRow | null> {
    return this.#tenant.findOne<TeamMemberRow>('team_member', {
      where: { team_id: teamId, participant_id: participantId },
    });
  }

  /** How many students are on a team now. */
  async countLiveMembers(teamId: string): Promise<number> {
    return this.#tenant.count('team_member', { team_id: teamId, left_at: null });
  }

  /** Puts a student on a team for the first time. */
  async insertMembership(
    teamId: string,
    participantId: string,
    membership: TeamMembership,
  ): Promise<TeamMemberRow> {
    return this.#tenant.insert<TeamMemberRow>('team_member', {
      team_id: teamId,
      participant_id: participantId,
      role: membership.role,
      is_leader: membership.isLeader,
      left_at: null,
    });
  }

  /**
   * Puts a student back on a team they were on before.
   *
   * `UNIQUE (team_id, participant_id)` has no predicate on it, so the row
   * from the first time round is still there and a second insert would be
   * refused. Coming back reuses it, and `joined_at` moves to now so that the
   * order members are listed in is the order they are on the team in.
   */
  async rejoinTeam(
    membershipId: string,
    membership: TeamMembership,
    at: Date,
  ): Promise<TeamMemberRow | null> {
    return this.#tenant.updateById<TeamMemberRow>('team_member', membershipId, {
      role: membership.role,
      is_leader: membership.isLeader,
      joined_at: at,
      left_at: null,
    });
  }

  /** Changes the role or the leader flag on a membership that is already live. */
  async updateMembership(
    membershipId: string,
    membership: TeamMembership,
  ): Promise<TeamMemberRow | null> {
    return this.#tenant.updateById<TeamMemberRow>('team_member', membershipId, {
      role: membership.role,
      is_leader: membership.isLeader,
    });
  }

  /** Ends a membership. The row stays, so the team's history does too. */
  async endMembership(membershipId: string, at: Date): Promise<TeamMemberRow | null> {
    return this.#tenant.updateById<TeamMemberRow>('team_member', membershipId, {
      left_at: at,
      is_leader: false,
    });
  }

  /**
   * Takes the leader flag off whoever holds it on a team.
   *
   * Run before a new leader is named, because
   * `team_member_single_leader_idx` allows one live leader per team and would
   * otherwise refuse the second.
   */
  async clearLeader(teamId: string): Promise<number> {
    const rows = await this.#tenant.update<TeamMemberRow>(
      'team_member',
      { team_id: teamId, is_leader: true, left_at: null },
      { is_leader: false },
    );
    return rows.length;
  }
}

/** Builds the repository from the one the middleware made. */
export function participationRepository(
  tenant: TenantRepository,
): ParticipationRepository {
  return new ParticipationRepository(tenant);
}
