/**
 * The tables a leaderboard is drawn from (EXPD-022).
 *
 * Read only. Nothing here writes, because a leaderboard is a view of figures
 * other tickets keep:
 *
 *   `team.total_score`         the kept total (EXPD-014 keeps it beside the stream)
 *   `team.failed_attempts`     the wrong answers (EXPD-020, migration 0006)
 *   `mission_transition`       which missions a team finished (EXPD-020)
 *   `hint_request`             which hints a team opened (EXPD-020)
 *   `progression_event`        when a team finished the expedition (EXPD-014)
 *
 * Every read names the columns it wants. That is how the student data stays
 * out: a participant is read for `display_name` and `status` and nothing else,
 * so a device id or an account id is never in memory to leak by mistake.
 *
 * Every call goes through a `TenantRepository`, so another organisation's rows
 * are never read (EXPD-004).
 */

import { COUNTED_TEAM_STATUSES } from '@explorer/shared-types';

import type { TenantRepository } from '../db/tenant-repository.ts';
import type {
  ExpeditionSessionRow,
  ExpeditionVersionRow,
} from '../repositories/rows.ts';

/** The columns of `team` a leaderboard reads. */
export interface LeaderboardTeamRow {
  readonly id: string;
  readonly expedition_session_id: string;
  readonly name: string;
  readonly total_score: number;
  readonly failed_attempts: number;
  readonly finished_at: Date | string | null;
}

/** The runs, teams and figures of one organisation, for its leaderboards. */
export class LeaderboardRepository {
  readonly #tenant: TenantRepository;

  constructor(tenant: TenantRepository) {
    this.#tenant = tenant;
  }

  async findSession(id: string): Promise<ExpeditionSessionRow | null> {
    return this.#tenant.findById<ExpeditionSessionRow>('expedition_session', id);
  }

  /** The runs of one expedition that are over and were played to the end. */
  async listEndedSessions(expeditionId: string): Promise<ExpeditionSessionRow[]> {
    return this.#tenant.find<ExpeditionSessionRow>('expedition_session', {
      where: { expedition_id: expeditionId, status: 'ended' },
      orderBy: [
        { column: 'created_at', direction: 'desc' },
        { column: 'id', direction: 'desc' },
      ],
    });
  }

  /** Whether this organisation has the expedition at all. */
  async expeditionExists(expeditionId: string): Promise<boolean> {
    return this.#tenant.exists('expedition', { id: expeditionId });
  }

  /** The revisions the runs are pinned to, for their leaderboard settings. */
  async listVersions(ids: readonly string[]): Promise<ExpeditionVersionRow[]> {
    return this.#tenant.find<ExpeditionVersionRow>('expedition_version', {
      where: { id: [...ids] },
      columns: ['id', 'definition_version', 'definition'],
    });
  }

  /** The teams in some runs. A withdrawn team is left out: it was taken out. */
  async listTeams(sessionIds: readonly string[]): Promise<LeaderboardTeamRow[]> {
    return this.#tenant.find<LeaderboardTeamRow>('team', {
      where: { expedition_session_id: [...sessionIds], status: [...COUNTED_TEAM_STATUSES] },
      columns: ['id', 'expedition_session_id', 'name', 'total_score', 'failed_attempts', 'finished_at'],
    });
  }

  /** Every line saying a team finished a mission, in some runs. */
  async listCompletions(
    sessionIds: readonly string[],
  ): Promise<{ team_id: string; mission_instance_key: string }[]> {
    return this.#tenant.find('mission_transition', {
      where: { expedition_session_id: [...sessionIds], to_state: 'complete' },
      columns: ['team_id', 'mission_instance_key'],
    });
  }

  /** Every hint opened, in some runs. Only the team: not who asked. */
  async listHintsOpened(sessionIds: readonly string[]): Promise<{ team_id: string }[]> {
    return this.#tenant.find('hint_request', {
      where: { expedition_session_id: [...sessionIds] },
      columns: ['team_id'],
    });
  }

  /** Every line saying a team finished the expedition, in some runs. */
  async listFinishes(
    sessionIds: readonly string[],
  ): Promise<{ team_id: string; occurred_at: Date | string }[]> {
    return this.#tenant.find('progression_event', {
      where: { expedition_session_id: [...sessionIds], reason: 'expedition-finished' },
      columns: ['team_id', 'occurred_at'],
    });
  }

  /** Who is on some teams now. Ids only: the names are read separately. */
  async listMembers(
    teamIds: readonly string[],
  ): Promise<{ team_id: string; participant_id: string; joined_at: Date | string }[]> {
    return this.#tenant.find('team_member', {
      where: { team_id: [...teamIds], left_at: null },
      columns: ['team_id', 'participant_id', 'joined_at'],
    });
  }

  /**
   * Some students' display names, and whether they are still in the run.
   *
   * `display_name` and `status`, and no other column: this is the one read of
   * a child's row, and it takes what a leaderboard shows and nothing more.
   */
  async listDisplayNames(
    participantIds: readonly string[],
  ): Promise<{ id: string; display_name: string; status: string }[]> {
    return this.#tenant.find('participant', {
      where: { id: [...participantIds] },
      columns: ['id', 'display_name', 'status'],
    });
  }
}
