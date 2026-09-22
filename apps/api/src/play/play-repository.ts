/**
 * The tables a team playing a mission touches (EXPD-020).
 *
 * Built on a `TenantRepository`, so every read and write here is pinned to
 * one organisation and has no way to ask for another's rows. Nothing here
 * decides anything: which change is allowed is the engine's, and which rows a
 * change writes is `play-service.ts`'s.
 */

import type { MissionTransition } from '@explorer/shared-types';

import type { Queryable } from '../db/queryable.ts';
import type { TenantRepository } from '../db/tenant-repository.ts';
import type {
  AttemptStatus,
  ExpeditionSessionRow,
  ExpeditionVersionRow,
  HintRequestRow,
  MissionAttemptRow,
  MissionInstanceRow,
  MissionTransitionRow,
  ParticipantRow,
  SubmissionRow,
  SubmissionStatus,
  TeamMemberRow,
  TeamPlayRow,
} from '../repositories/rows.ts';
import { missionTransitionColumns } from './mission-log.ts';

/** Which team, in which run. Every write below names both. */
export interface TeamScope {
  readonly teamId: string;
  readonly expeditionSessionId: string;
}

/** The running counts on `team` that move with a score. */
export interface TeamScorePatch {
  readonly totalScore: number;
  readonly streak: number;
  readonly longestStreak: number;
  readonly failedAttempts: number;
}

/** What a new try is made of. */
export interface NewAttempt {
  readonly missionInstanceId: string;
  readonly openedBy: string | null;
  readonly attemptNumber: number;
  readonly startedAt: Date;
  readonly deadlineAt: Date | null;
}

/** What a new submission is made of. */
export interface NewSubmission {
  readonly missionAttemptId: string;
  readonly participantId: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: SubmissionStatus;
  readonly isLate: boolean;
  readonly submittedAt: Date;
  readonly receivedAt: Date;
}

/** Everything a request playing a mission reads and writes. */
export class PlayRepository {
  readonly #tenant: TenantRepository;

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  /** The same repository on another connection, such as a transaction. */
  withConnection(db: Queryable): PlayRepository {
    return new PlayRepository(this.#tenant.withConnection(db));
  }

  // --- The run, and who is in it -------------------------------------------

  async findSession(id: string): Promise<ExpeditionSessionRow | null> {
    return this.#tenant.findById<ExpeditionSessionRow>('expedition_session', id);
  }

  async findPinnedVersion(id: string): Promise<ExpeditionVersionRow | null> {
    return this.#tenant.findById<ExpeditionVersionRow>('expedition_version', id);
  }

  async findParticipant(
    expeditionSessionId: string,
    participantId: string,
  ): Promise<ParticipantRow | null> {
    return this.#tenant.findOne<ParticipantRow>('participant', {
      where: { id: participantId, expedition_session_id: expeditionSessionId },
    });
  }

  /** The team a student is on now, as a membership row, or null. */
  async findLiveMembership(participantId: string): Promise<TeamMemberRow | null> {
    return this.#tenant.findOne<TeamMemberRow>('team_member', {
      where: { participant_id: participantId, left_at: null },
    });
  }

  /**
   * One team in one run.
   *
   * With `forUpdate`, the row is locked to the end of the transaction. Every
   * write below reads the team this way first, so two phones on one team
   * pressing submit at the same moment are played one after the other rather
   * than both building on the same history.
   */
  async findTeam(
    scope: TeamScope,
    options: { readonly forUpdate?: boolean } = {},
  ): Promise<TeamPlayRow | null> {
    return this.#tenant.findOne<TeamPlayRow>('team', {
      where: { id: scope.teamId, expedition_session_id: scope.expeditionSessionId },
      ...(options.forUpdate === true ? { forUpdate: true } : {}),
    });
  }

  async updateTeamScore(teamId: string, patch: TeamScorePatch): Promise<void> {
    await this.#tenant.updateById('team', teamId, {
      total_score: patch.totalScore,
      streak: patch.streak,
      longest_streak: patch.longestStreak,
      failed_attempts: patch.failedAttempts,
    });
  }

  // --- The flat copy of the revision (EXPD-017) ----------------------------

  /** The `mission_instance` row a document id resolves to in one revision. */
  async findMissionInstance(
    expeditionVersionId: string,
    instanceKey: string,
  ): Promise<MissionInstanceRow | null> {
    return this.#tenant.findOne<MissionInstanceRow>('mission_instance', {
      where: { expedition_version_id: expeditionVersionId, instance_key: instanceKey },
    });
  }

  /** The `hint` row a document id resolves to, or null. */
  async findHintId(missionInstanceId: string, hintKey: string): Promise<string | null> {
    const row = await this.#tenant.findOne<{ id: string }>('hint', {
      where: { mission_instance_id: missionInstanceId, hint_key: hintKey },
      columns: ['id'],
    });
    return row?.id ?? null;
  }

  // --- Mission histories ----------------------------------------------------

  /** Every line of every mission's history for one team, in order. */
  async listTransitions(teamId: string): Promise<MissionTransitionRow[]> {
    return this.#tenant.find<MissionTransitionRow>('mission_transition', {
      where: { team_id: teamId },
      orderBy: [{ column: 'sequence', direction: 'asc' }],
    });
  }

  /** Appends lines to one mission's history, numbered from `firstSequence`. */
  async appendTransitions(
    scope: TeamScope,
    missionInstanceKey: string,
    transitions: readonly MissionTransition[],
    firstSequence: number,
    missionAttemptId: string | null,
  ): Promise<void> {
    let sequence = firstSequence;
    for (const transition of transitions) {
      await this.#tenant.insert('mission_transition', {
        expedition_session_id: scope.expeditionSessionId,
        team_id: scope.teamId,
        mission_instance_key: missionInstanceKey,
        mission_attempt_id: missionAttemptId,
        sequence,
        ...(missionTransitionColumns(transition) as Record<string, never>),
      });
      sequence += 1;
    }
  }

  // --- Tries and what was handed in -----------------------------------------

  /** The newest try a team has made at a mission, or null. */
  async findLatestAttempt(
    teamId: string,
    missionInstanceId: string,
  ): Promise<MissionAttemptRow | null> {
    return this.#tenant.findOne<MissionAttemptRow>('mission_attempt', {
      where: { team_id: teamId, mission_instance_id: missionInstanceId },
      orderBy: [{ column: 'attempt_number', direction: 'desc' }],
    });
  }

  async insertAttempt(scope: TeamScope, attempt: NewAttempt): Promise<MissionAttemptRow> {
    return this.#tenant.insert<MissionAttemptRow>('mission_attempt', {
      expedition_session_id: scope.expeditionSessionId,
      team_id: scope.teamId,
      mission_instance_id: attempt.missionInstanceId,
      opened_by: attempt.openedBy,
      attempt_number: attempt.attemptNumber,
      status: 'open',
      started_at: attempt.startedAt,
      deadline_at: attempt.deadlineAt,
      completed_at: null,
      awarded_points: null,
    });
  }

  async updateAttempt(
    id: string,
    patch: {
      readonly status: AttemptStatus;
      readonly completedAt: Date | null;
      readonly awardedPoints?: number | null;
    },
  ): Promise<MissionAttemptRow | null> {
    return this.#tenant.updateById<MissionAttemptRow>('mission_attempt', id, {
      status: patch.status,
      completed_at: patch.completedAt,
      ...(patch.awardedPoints === undefined ? {} : { awarded_points: patch.awardedPoints }),
    });
  }

  /**
   * Whether some other team in the run has already finished this mission.
   *
   * What `first-to-complete-bonus` (EXPD-012) is told. The engine cannot know
   * it, because it is a fact about every other team.
   */
  async completedByAnotherTeam(
    expeditionSessionId: string,
    missionInstanceId: string,
    teamId: string,
  ): Promise<boolean> {
    const rows = await this.#tenant.find<{ team_id: string }>('mission_attempt', {
      where: {
        expedition_session_id: expeditionSessionId,
        mission_instance_id: missionInstanceId,
        status: 'succeeded',
      },
      columns: ['team_id'],
    });
    return rows.some((row) => row.team_id !== teamId);
  }

  async insertSubmission(submission: NewSubmission): Promise<SubmissionRow> {
    return this.#tenant.insert<SubmissionRow>('submission', {
      mission_attempt_id: submission.missionAttemptId,
      participant_id: submission.participantId,
      payload: submission.payload,
      status: submission.status,
      is_late: submission.isLate,
      submitted_at: submission.submittedAt,
      received_at: submission.receivedAt,
      reviewed_at: null,
      reviewed_by: null,
      review_note: null,
    });
  }

  /** The submission on a try that is waiting for a teacher, or null. */
  async findSubmissionAwaitingReview(missionAttemptId: string): Promise<SubmissionRow | null> {
    return this.#tenant.findOne<SubmissionRow>('submission', {
      where: { mission_attempt_id: missionAttemptId, status: 'needs-review' },
      orderBy: [{ column: 'submitted_at', direction: 'desc' }],
    });
  }

  async recordReview(
    id: string,
    review: {
      readonly status: 'accepted' | 'rejected';
      readonly reviewedAt: Date;
      readonly reviewedBy: string;
      readonly note: string | null;
    },
  ): Promise<SubmissionRow | null> {
    return this.#tenant.updateById<SubmissionRow>('submission', id, {
      status: review.status,
      reviewed_at: review.reviewedAt,
      reviewed_by: review.reviewedBy,
      review_note: review.note,
    });
  }

  // --- Hints ------------------------------------------------------------------

  async listHintRequests(teamId: string): Promise<HintRequestRow[]> {
    return this.#tenant.find<HintRequestRow>('hint_request', {
      where: { team_id: teamId },
      orderBy: [{ column: 'opened_at', direction: 'asc' }],
    });
  }

  async insertHintRequest(
    scope: TeamScope,
    request: {
      readonly participantId: string | null;
      readonly missionInstanceKey: string;
      readonly hintKey: string;
      readonly openedAt: Date;
    },
  ): Promise<HintRequestRow> {
    return this.#tenant.insert<HintRequestRow>('hint_request', {
      expedition_session_id: scope.expeditionSessionId,
      team_id: scope.teamId,
      participant_id: request.participantId,
      mission_instance_key: request.missionInstanceKey,
      hint_key: request.hintKey,
      opened_at: request.openedAt,
    });
  }
}
