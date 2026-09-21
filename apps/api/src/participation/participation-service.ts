/**
 * What a join, team and participant endpoint actually does (EXPD-018).
 *
 * The rules of the ticket live here, and there are five of them.
 *
 *   **A code finds a run, and the run fixes the organisation.** Everything
 *   after that point is scoped, and a student typing a code never says which
 *   school they are in. `JoinCodeDirectory` owns the one crossing and
 *   explains it.
 *
 *   **A student is in the run before they are on a team.** Joining puts
 *   somebody in the lobby. Which team they end up on is a teacher's to say,
 *   and it is a second call.
 *
 *   **A student is on one team at a time.** Moving ends one membership and
 *   starts another; it never leaves two open. Migration 0001's partial unique
 *   index says the same thing in the database, so a bug here is refused
 *   rather than stored.
 *
 *   **The limits come from the revision the run is pinned to.** How big a
 *   team may be, how many teams there may be, and which roles exist are
 *   `rules.teams` in the document (EXPD-002), read fresh each time. A run
 *   started on revision 3 keeps revision 3's limits however much the author
 *   changes afterwards.
 *
 *   **A phone that comes back is the same student.** Rejoining with the same
 *   device id finds the participant that phone already is, rather than
 *   putting a second copy of a nine-year-old in the lobby.
 *
 * Every write is one transaction, and the audit entry (EXPD-006) is inside
 * it, so a change and the record of who made it cannot exist without each
 * other. Two writes here have no entry, and both are deliberate: joining is
 * done by somebody who does not exist yet when the request starts, and the
 * audit vocabulary EXPD-006 fixed has no action for a code being reissued.
 * The vocabulary is EXPD-006's to widen, not this ticket's.
 */

import {
  COUNTED_TEAM_STATUSES,
  PRESENT_PARTICIPANT_STATUSES,
  isJoinableSessionStatus,
  toId,
  type OrganisationId,
  type ParticipantStatus,
  type TeamRules,
} from '@explorer/shared-types';

import type { AuditLog } from '../audit/audit-log.ts';
import { inTransaction, type Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import { ApiError, notFound } from '../http/errors.ts';
import type { DeviceRepository } from '../repositories/device-repository.ts';
import type {
  ExpeditionSessionRow,
  ParticipantRow,
  TeamMemberRow,
  TeamRow,
} from '../repositories/rows.ts';
import { allocateJoinCode, normaliseJoinCode } from './join-codes.ts';
import type { JoinCodeDirectory } from './join-code-directory.ts';
import { ParticipationRepository, type TeamMembership } from './participation-repository.ts';
import { participantCapacityOf, teamRulesOf } from './team-rules.ts';
import {
  toJoinCodeView,
  toParticipantView,
  toSessionSummaryView,
  toTeamLimitsView,
  toTeamView,
  type JoinCodeView,
  type JoinView,
  type ParticipantListView,
  type ParticipantView,
  type TeamListView,
  type TeamView,
} from './views.ts';

/** The most a student's display name may be. */
export const MAX_DISPLAY_NAME = 80;

/** The most a team's name may be. */
export const MAX_TEAM_NAME = 80;

/**
 * What putting a student on a team says about them.
 *
 * The whole membership, not a patch of it: a missing `role` means no role and
 * a missing `isLeader` means not the leader, because the endpoint that takes
 * this is a PUT. That is how a role is taken away again.
 */
export interface AssignToTeamInput {
  readonly teamId: string;
  /** One of `rules.teams.roles`. Absent means no role. */
  readonly role?: string | undefined;
  /** Whether they speak for the team. At most one member does. */
  readonly isLeader?: boolean | undefined;
}

/** What a phone sends when it types a code. */
export interface JoinInput {
  readonly joinCode: string;
  readonly displayName: string;
  /** Identifies the phone, never a person (EXPD-071). */
  readonly deviceId: string;
}

/**
 * Turning a code into a place in a run.
 *
 * Stands apart from `ParticipationService` because it runs before there is a
 * principal, a tenant repository or an audit actor. It builds its own
 * repository once the code has said which organisation to build it for, and
 * hands back the device token the phone then signs in with.
 */
export class JoinService {
  readonly #db: Queryable;
  readonly #directory: JoinCodeDirectory;
  readonly #tenantFor: (organisationId: OrganisationId) => TenantRepository;
  readonly #devicesFor: (organisationId: OrganisationId) => DeviceRepository;
  readonly #deviceSeconds: number;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: Queryable;
    readonly directory: JoinCodeDirectory;
    readonly tenantFor: (organisationId: OrganisationId) => TenantRepository;
    readonly devicesFor: (organisationId: OrganisationId) => DeviceRepository;
    /** How long the device token lives. `AuthConfig`'s `deviceSeconds`. */
    readonly deviceSeconds: number;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#directory = options.directory;
    this.#tenantFor = options.tenantFor;
    this.#devicesFor = options.devicesFor;
    this.#deviceSeconds = options.deviceSeconds;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * Puts a student in a run.
   *
   * Every way this can fail short of a real fault is answered the same way: a
   * code that is not a code, a code no run is using, and a code for a run
   * that has ended are all `404`. There is no reason to tell somebody typing
   * codes at random which of those they hit.
   *
   * A student who was removed from this run is the one case answered
   * differently, with `409`. They typed a code that really does reach a run,
   * they really were in it, and a teacher really did take them out — telling
   * them "there is no such run" would send them round the loop of typing it
   * again while the teacher wonders why.
   */
  async join(input: JoinInput): Promise<JoinView> {
    const code = normaliseJoinCode(input.joinCode);
    const match = await this.#directory.findJoinableSession(code, {
      reason: 'join: a student typing a code has no organisation to be scoped to',
    });
    if (match === null) {
      throw notFound('run with that join code');
    }

    const tenant = this.#tenantFor(match.organisationId);
    const runs = new ParticipationRepository(tenant);
    const session = await runs.findSession(match.expeditionSessionId);
    if (session === null || !isJoinableSessionStatus(session.status)) {
      throw notFound('run with that join code');
    }

    const rules = await teamRulesFor(runs, session);
    const displayName = input.displayName.trim();
    const now = this.#now();

    return inTransaction(this.#db, async (tx) => {
      const scoped = runs.withConnection(tx);
      const participant = await this.#participantFor(scoped, session, {
        ...input,
        displayName,
      }, rules);

      const membership = await scoped.findLiveMembership(participant.id);
      const issued = await this.#devicesFor(match.organisationId)
        .withConnection(tx)
        .issueDeviceToken(
          {
            participantId: toId<'participant'>(participant.id),
            expeditionSessionId: toId<'expeditionSession'>(session.id),
            deviceId: input.deviceId,
            expiresAt: new Date(now.getTime() + this.#deviceSeconds * 1000),
          },
          now,
        );

      return {
        session: toSessionSummaryView(session),
        organisationId: match.organisationId,
        participant: toParticipantView(participant, membership),
        team: membership === null
          ? null
          : await teamViewFor(scoped, session.id, membership.team_id, rules),
        deviceToken: issued.token,
        deviceTokenExpiresAt: issued.device.expires_at.toISOString(),
      };
    });
  }

  /**
   * The student this phone is, whether it is arriving or coming back.
   *
   * A phone that already has a participant in this run gets it back, with
   * whatever name it sent this time: a student who typed `Sam` and meant
   * `Sammy` should be able to fix it by rejoining rather than by asking a
   * teacher. Somebody who was removed is refused, and somebody who left comes
   * back as joined.
   */
  async #participantFor(
    runs: ParticipationRepository,
    session: ExpeditionSessionRow,
    input: JoinInput,
    rules: TeamRules,
  ): Promise<ParticipantRow> {
    const existing = await runs.findParticipantByDevice(session.id, input.deviceId);

    if (existing !== null && existing.status === 'removed') {
      throw new ApiError('conflict', {
        message: 'This device was removed from that run by a teacher.',
        detail: `participant ${existing.id} is removed from run ${session.id}`,
      });
    }

    if (existing !== null) {
      const updated = await runs.updateParticipant(existing.id, {
        displayName: input.displayName,
        status: 'joined',
        leftAt: null,
      });
      return updated ?? existing;
    }

    await assertRoomForOneMore(runs, session, rules);

    return runs.insertParticipant({
      expeditionSessionId: session.id,
      displayName: input.displayName,
      deviceId: input.deviceId,
      status: 'joined',
    });
  }
}

/**
 * What one staff request may do to a run's teams and students.
 *
 * Built per request on the repository the middleware made, so the
 * organisation is fixed before this class exists and there is no method that
 * takes one.
 */
export class ParticipationService {
  readonly #db: Queryable;
  readonly #runs: ParticipationRepository;
  readonly #directory: JoinCodeDirectory;
  readonly #devices: DeviceRepository;
  readonly #audit: AuditLog;
  readonly #now: () => Date;

  constructor(options: {
    readonly db: Queryable;
    readonly tenant: TenantRepository;
    readonly directory: JoinCodeDirectory;
    readonly devices: DeviceRepository;
    /**
     * The log every write here appends to.
     *
     * It already names the caller: `auditScope` built it from the principal,
     * so there is nothing for this class to be told about who is calling and
     * no way for it to name somebody else.
     */
    readonly audit: AuditLog;
    readonly now?: () => Date;
  }) {
    this.#db = options.db;
    this.#runs = new ParticipationRepository(options.tenant);
    this.#directory = options.directory;
    this.#devices = options.devices;
    this.#audit = options.audit;
    this.#now = options.now ?? (() => new Date());
  }

  // --- The code -----------------------------------------------------------

  /** The code a run is joined with. */
  async readJoinCode(sessionId: string): Promise<JoinCodeView> {
    return toJoinCodeView(await this.#requireSession(this.#runs, sessionId));
  }

  /**
   * Gives a run a new code, and stops the old one working.
   *
   * What a teacher does when the code has left the classroom: a photograph of
   * the whiteboard, a sibling who has it. A new code is allocated against
   * every joinable run rather than against this organisation's, because the
   * index it has to satisfy is not scoped to one.
   *
   * A run that has ended is refused. Its code is already back in the pool,
   * and minting another would only put a second dead code beside the first.
   */
  async reissueJoinCode(sessionId: string): Promise<JoinCodeView> {
    return inTransaction(this.#db, async (tx) => {
      const runs = this.#runs.withConnection(tx);
      const session = await this.#requireSession(runs, sessionId, { forUpdate: true });

      if (!isJoinableSessionStatus(session.status)) {
        throw new ApiError('conflict', {
          message: 'That run is over, so a join code would reach nothing.',
          detail: `run ${session.id} is ${session.status}`,
        });
      }

      const directory = this.#directory.withConnection(tx);
      const code = await allocateJoinCode((candidate) =>
        directory.isJoinCodeTaken(candidate, {
          reason:
            'reissue: a join code has to be unique across every joinable run, ' +
            'not only this organisation’s',
        }),
      );

      const updated = await runs.setJoinCode(session.id, code);
      return toJoinCodeView(updated ?? session);
    });
  }

  // --- Reading the team sheet ---------------------------------------------

  /** Every team in a run, with who is on each. */
  async listTeams(sessionId: string): Promise<TeamListView> {
    const session = await this.#requireSession(this.#runs, sessionId);
    const rules = await teamRulesFor(this.#runs, session);

    const teams = await this.#runs.listTeams(sessionId);
    const members = await this.#runs.listMembers(teams.map((team) => team.id));
    const names = await this.#namesIn(sessionId);

    const counted = teams.filter((team) =>
      (COUNTED_TEAM_STATUSES as readonly string[]).includes(team.status),
    ).length;

    return {
      session: toSessionSummaryView(session),
      limits: toTeamLimitsView(rules),
      teams: teams.map((team) =>
        toTeamView(team, membersOf(members, team.id), names, rules),
      ),
      placesLeft: rules.maxTeams === null ? null : Math.max(0, rules.maxTeams - counted),
    };
  }

  /** Every student in a run, and the team each is on. */
  async listParticipants(sessionId: string): Promise<ParticipantListView> {
    const session = await this.#requireSession(this.#runs, sessionId);
    const rules = await teamRulesFor(this.#runs, session);

    const participants = await this.#runs.listParticipants(sessionId);
    const teams = await this.#runs.listTeams(sessionId);
    const members = await this.#runs.listMembers(teams.map((team) => team.id));
    const byParticipant = new Map(
      members.map((member) => [member.participant_id, member]),
    );

    return {
      session: toSessionSummaryView(session),
      limits: toTeamLimitsView(rules),
      participants: participants.map((row) =>
        toParticipantView(row, byParticipant.get(row.id) ?? null),
      ),
      presentCount: participants.filter((row) => isPresent(row.status)).length,
    };
  }

  // --- Making teams -------------------------------------------------------

  /**
   * Adds a team to a run.
   *
   * Refused when the expedition caps the number of teams and the run already
   * has that many, and refused when the name is taken: migration 0001 has
   * `UNIQUE (expedition_session_id, name)`, and two teams called *Red* on one
   * team sheet would be a worse answer than an error.
   */
  async createTeam(sessionId: string, input: { readonly name: string }): Promise<TeamView> {
    const name = input.name.trim();

    return inTransaction(this.#db, async (tx) => {
      const runs = this.#runs.withConnection(tx);
      const session = await this.#requireSession(runs, sessionId, { forUpdate: true });
      const rules = await teamRulesFor(runs, session);

      if (rules.maxTeams !== null) {
        const counted = await runs.countTeams(sessionId, COUNTED_TEAM_STATUSES);
        if (counted >= rules.maxTeams) {
          throw new ApiError('conflict', {
            message:
              `This expedition allows ${String(rules.maxTeams)} teams, ` +
              'and the run already has that many.',
            detail: `run ${sessionId} has ${String(counted)} teams`,
          });
        }
      }

      const teams = await runs.listTeams(sessionId);
      if (teams.some((team) => team.name === name)) {
        throw new ApiError('conflict', {
          message: 'This run already has a team with that name.',
          detail: `run ${sessionId} already has a team called ${JSON.stringify(name)}`,
        });
      }

      const team = await runs.insertTeam({ expeditionSessionId: sessionId, name });
      return toTeamView(team, [], new Map(), rules);
    });
  }

  // --- Who is on which team -----------------------------------------------

  /**
   * Puts a student on a team, and says what they do there.
   *
   * The one door for both halves of "assign participants and roles": calling
   * it for a student who is already on that team changes their role and
   * whether they lead it, and leaves the membership where it is. Calling it
   * for a student on another team moves them, which ends the first membership
   * before the second one starts.
   *
   * Three things are checked before anything is written. The role has to be
   * one the expedition hands out, the team has to have room, and the student
   * has to still be in the run — somebody a teacher removed is not put back
   * by being assigned to a team.
   */
  async assignToTeam(
    sessionId: string,
    participantId: string,
    input: AssignToTeamInput,
  ): Promise<ParticipantView> {
    return inTransaction(this.#db, async (tx) => {
      const runs = this.#runs.withConnection(tx);
      const session = await this.#requireSession(runs, sessionId, { forUpdate: true });
      const rules = await teamRulesFor(runs, session);

      const participant = await this.#requireParticipant(runs, sessionId, participantId);
      const team = await runs.findTeam(sessionId, input.teamId, { forUpdate: true });
      if (team === null) {
        throw notFound('team in that run');
      }

      const role = roleFor(input.role, rules);
      const isLeader = input.isLeader === true;
      const membership: TeamMembership = { role, isLeader };

      const live = await runs.findLiveMembership(participantId);
      const before = {
        team_id: live === null ? null : live.team_id,
        role: live === null ? null : live.role,
        is_leader: live !== null && live.is_leader,
      };

      if (live !== null && live.team_id === team.id) {
        await this.#nameLeader(runs, team.id, isLeader);
        const updated = await runs.updateMembership(live.id, membership);
        await this.#recordTeamChange(tx, participant, before, team, updated ?? live);
        return toParticipantView(participant, updated ?? live);
      }

      await assertRoomOnTeam(runs, team, rules);

      if (live !== null) {
        await runs.endMembership(live.id, this.#now());
      }
      await this.#nameLeader(runs, team.id, isLeader);

      const joined = await this.#startMembership(runs, team, participantId, membership);
      await this.#recordTeamChange(tx, participant, before, team, joined);
      return toParticipantView(participant, joined);
    });
  }

  /**
   * Takes a student off their team, leaving them in the run.
   *
   * The lobby is where a student who is in the run and on no team is, and it
   * is where this puts them. It is not removal: they can still be put on
   * another team, and their phone goes on working.
   */
  async leaveTeam(sessionId: string, participantId: string): Promise<ParticipantView> {
    return inTransaction(this.#db, async (tx) => {
      const runs = this.#runs.withConnection(tx);
      await this.#requireSession(runs, sessionId);
      const participant = await this.#requireParticipant(runs, sessionId, participantId);

      const live = await runs.findLiveMembership(participantId);
      if (live === null) {
        throw new ApiError('conflict', {
          message: 'That student is not on a team.',
          detail: `participant ${participantId} has no live team_member row`,
        });
      }

      await runs.endMembership(live.id, this.#now());
      await this.#audit.withConnection(tx).record('participant.team-changed', {
        entityId: participantId,
        before: { team_id: live.team_id, role: live.role, is_leader: live.is_leader },
        after: { team_id: null, role: null, is_leader: false },
      });

      return toParticipantView(participant, null);
    });
  }

  /**
   * Takes a student out of the run altogether.
   *
   * Three things at once, and all three in one transaction: the student is
   * marked removed, their team membership is ended, and every device token
   * their phone holds for this run is withdrawn. The last one is the point —
   * a student taken out of a lesson whose phone goes on submitting work is
   * not out of the lesson.
   *
   * The row stays. A removed student is part of what happened in that run,
   * and their team's event stream (EXPD-014) points at them.
   */
  async removeParticipant(
    sessionId: string,
    participantId: string,
  ): Promise<ParticipantView> {
    return inTransaction(this.#db, async (tx) => {
      const runs = this.#runs.withConnection(tx);
      await this.#requireSession(runs, sessionId);
      const participant = await this.#requireParticipant(runs, sessionId, participantId);

      if (participant.status === 'removed') {
        throw new ApiError('conflict', {
          message: 'That student has already been removed from this run.',
          detail: `participant ${participantId} is already removed`,
        });
      }

      const now = this.#now();
      const live = await runs.findLiveMembership(participantId);
      if (live !== null) {
        await runs.endMembership(live.id, now);
      }

      const removed = await runs.updateParticipant(participantId, {
        status: 'removed',
        leftAt: now,
      });
      const devices = await this.#devices
        .withConnection(tx)
        .revokeDevicesForParticipant(participantId, 'admin', now);

      await this.#audit.withConnection(tx).record('participant.removed', {
        entityId: participantId,
        before: { status: participant.status, team_id: live === null ? null : live.team_id },
        after: { status: 'removed', team_id: null, devices_revoked: devices },
      });

      return toParticipantView(removed ?? participant, null);
    });
  }

  // --- The pieces the methods above share ---------------------------------

  /** Starts a membership, reusing the row from last time when there is one. */
  async #startMembership(
    runs: ParticipationRepository,
    team: TeamRow,
    participantId: string,
    membership: TeamMembership,
  ): Promise<TeamMemberRow> {
    const previous = await runs.findMembership(team.id, participantId);
    if (previous === null) {
      return runs.insertMembership(team.id, participantId, membership);
    }
    const rejoined = await runs.rejoinTeam(previous.id, membership, this.#now());
    return rejoined ?? previous;
  }

  /** Makes room for a new leader, when one is being named. */
  async #nameLeader(
    runs: ParticipationRepository,
    teamId: string,
    isLeader: boolean,
  ): Promise<void> {
    if (isLeader) {
      await runs.clearLeader(teamId);
    }
  }

  /** Writes the one entry a move, a role or a leader change all produce. */
  async #recordTeamChange(
    tx: Queryable,
    participant: ParticipantRow,
    before: { team_id: string | null; role: string | null; is_leader: boolean },
    team: TeamRow,
    membership: TeamMemberRow,
  ): Promise<void> {
    await this.#audit.withConnection(tx).record('participant.team-changed', {
      entityId: participant.id,
      before,
      after: {
        team_id: team.id,
        role: membership.role,
        is_leader: membership.is_leader,
      },
    });
  }

  /** What each student in a run is called, for a team sheet. */
  async #namesIn(sessionId: string): Promise<Map<string, string>> {
    const participants = await this.#runs.listParticipants(sessionId);
    return new Map(participants.map((row) => [row.id, row.display_name]));
  }

  /**
   * One run, or `404`.
   *
   * Another organisation's run answers `404` rather than `403`, for the
   * reason EXPD-017 gives: "you may not touch that" would be telling
   * Riverbank Academy that Portside School has a run with that id.
   */
  async #requireSession(
    runs: ParticipationRepository,
    sessionId: string,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<ExpeditionSessionRow> {
    const session = await runs.findSession(sessionId, options);
    if (session === null) {
      throw notFound('run');
    }
    return session;
  }

  /** One student in that run, or `404`. */
  async #requireParticipant(
    runs: ParticipationRepository,
    sessionId: string,
    participantId: string,
  ): Promise<ParticipantRow> {
    const participant = await runs.findParticipant(sessionId, participantId);
    if (participant === null) {
      throw notFound('student in that run');
    }
    return participant;
  }
}

/** The rules the run's pinned revision lays down. */
async function teamRulesFor(
  runs: ParticipationRepository,
  session: ExpeditionSessionRow,
): Promise<TeamRules> {
  const version = await runs.findPinnedVersion(session.expedition_version_id);
  return teamRulesOf(version === null ? null : version.definition);
}

/** One team, read back with everybody on it. */
async function teamViewFor(
  runs: ParticipationRepository,
  sessionId: string,
  teamId: string,
  rules: TeamRules,
): Promise<TeamView | null> {
  const team = await runs.findTeam(sessionId, teamId);
  if (team === null) {
    return null;
  }
  const members = await runs.listMembers([teamId]);
  const participants = await runs.listParticipants(sessionId);
  const names = new Map(participants.map((row) => [row.id, row.display_name]));
  return toTeamView(team, members, names, rules);
}

/** Refuses a student who would be one too many for the run. */
async function assertRoomForOneMore(
  runs: ParticipationRepository,
  session: ExpeditionSessionRow,
  rules: TeamRules,
): Promise<void> {
  const capacity = participantCapacityOf(rules);
  if (capacity === null) {
    return;
  }

  const present = await runs.countParticipants(session.id, PRESENT_PARTICIPANT_STATUSES);
  if (present >= capacity) {
    throw new ApiError('conflict', {
      message: `That run is full. It holds ${String(capacity)} students.`,
      detail: `run ${session.id} holds ${String(present)} of ${String(capacity)}`,
    });
  }
}

/** Refuses a student who would be one too many for the team. */
async function assertRoomOnTeam(
  runs: ParticipationRepository,
  team: TeamRow,
  rules: TeamRules,
): Promise<void> {
  const members = await runs.countLiveMembers(team.id);
  if (members >= rules.size.max) {
    throw new ApiError('conflict', {
      message:
        `A team on this expedition holds ${String(rules.size.max)} students, ` +
        `and ${team.name} already has that many.`,
      detail: `team ${team.id} has ${String(members)} members`,
    });
  }
}

/**
 * The role a membership is given, having checked the expedition hands it out.
 *
 * An unknown role is `422` and not a silent `null`: a teacher who typed
 * `navigater` should be told, not quietly given a team with nobody
 * navigating.
 */
function roleFor(role: string | null | undefined, rules: TeamRules): string | null {
  if (role === null || role === undefined || role === '') {
    return null;
  }
  if (!rules.roles.includes(role)) {
    throw new ApiError('validation-failed', {
      details: [
        {
          path: 'role',
          message:
            rules.roles.length === 0
              ? 'This expedition hands out no roles.'
              : `This expedition's roles are ${rules.roles.join(', ')}.`,
        },
      ],
    });
  }
  return role;
}

/** Returns true when a student with this status is still in the run. */
function isPresent(status: ParticipantStatus): boolean {
  return (PRESENT_PARTICIPANT_STATUSES as readonly string[]).includes(status);
}

/** The live memberships of one team, out of a run's worth of them. */
function membersOf(
  members: readonly TeamMemberRow[],
  teamId: string,
): readonly TeamMemberRow[] {
  return members.filter((member) => member.team_id === teamId);
}
