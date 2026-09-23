/**
 * The rules of a leaderboard (EXPD-022).
 *
 * Two boards:
 *
 *   - **A run's board.** The teams in one run, placed. A teacher and every
 *     phone in the run read it.
 *   - **An expedition's board.** Every team from every run of one expedition
 *     that was played to the end, placed together. Staff only.
 *
 * **Who sees what** is the pinned revision's `scoring.leaderboard.visibility`
 * (EXPD-002), read as it describes itself:
 *
 *   | visibility     | a teacher             | a phone               |
 *   | -------------- | --------------------- | --------------------- |
 *   | `live`         | always                | always                |
 *   | `teacher-only` | always                | once the run is over  |
 *   | `final-only`   | once the run is over  | once the run is over  |
 *   | `hidden`       | never                 | never                 |
 *
 * A board that may not be seen yet still answers `200`, with `shown: false`
 * and no standings, so the student app can say "the results come at the end"
 * rather than guess from an error.
 *
 * **The figures are kept figures.** The total is `team.total_score`, which
 * EXPD-014 keeps beside the stream so that a leaderboard "does not have to add
 * up the stream on every read". The tie-break figures are counted from the
 * rows EXPD-020 writes. Nothing here re-judges or re-scores anything.
 */

import {
  isFinalSessionStatus,
  type LeaderboardConfig,
  type LeaderboardTieBreak,
  type LeaderboardVisibility,
} from '@explorer/shared-types';

import type { TenantRepository } from '../db/tenant-repository.ts';
import { notFound } from '../http/errors.ts';
import type { ExpeditionSessionRow, ExpeditionVersionRow } from '../repositories/rows.ts';
import {
  LeaderboardRepository,
  type LeaderboardTeamRow,
} from './leaderboard-repository.ts';
import { rankTeams, type TeamFigures } from './ranking.ts';
import type {
  ExpeditionLeaderboardView,
  ExpeditionStandingView,
  SessionLeaderboardView,
  SessionStandingView,
} from './views.ts';

/** The most teams one page of an expedition's board carries. */
export const MAX_LEADERBOARD_PAGE = 200;

/** How many teams a page of an expedition's board carries when not told. */
export const DEFAULT_LEADERBOARD_PAGE = 50;

/**
 * Used when a revision has no leaderboard settings. A published revision
 * always has them (EXPD-002 requires the field), so this is a fallback for a
 * document that should not exist, and it falls back to showing nothing.
 */
const NO_LEADERBOARD: LeaderboardConfig = { visibility: 'hidden', tieBreaks: [] };

/** Who is reading a board. */
export type LeaderboardViewer =
  | { readonly kind: 'staff' }
  /** A phone, which belongs to one run. */
  | { readonly kind: 'device'; readonly sessionId: string };

/** Whether a board may be shown to this kind of reader now. */
export function leaderboardShown(
  visibility: LeaderboardVisibility,
  viewer: LeaderboardViewer['kind'],
  final: boolean,
): boolean {
  switch (visibility) {
    case 'live':
      return true;
    case 'teacher-only':
      return viewer === 'staff' || final;
    case 'final-only':
      return final;
    case 'hidden':
      return false;
  }
}

/** The leaderboard settings a revision's document carries. */
export function leaderboardConfigOf(version: Pick<ExpeditionVersionRow, 'definition'>): LeaderboardConfig {
  const scoring = version.definition['scoring'] as { leaderboard?: LeaderboardConfig } | undefined;
  const config = scoring?.leaderboard;
  if (config === undefined || config === null || typeof config !== 'object') {
    return NO_LEADERBOARD;
  }
  return {
    visibility: config.visibility ?? NO_LEADERBOARD.visibility,
    tieBreaks: Array.isArray(config.tieBreaks) ? config.tieBreaks : [],
  };
}

/** What the service needs. */
export interface LeaderboardServiceOptions {
  readonly tenant: TenantRepository;
  /** The clock. Tests pass their own. */
  readonly now?: () => Date;
}

/** The figures of one team, and the run it is in. */
interface Figures extends TeamFigures {
  readonly sessionId: string;
}

/** Draws the boards of one organisation. */
export class LeaderboardService {
  readonly #repo: LeaderboardRepository;
  readonly #now: () => Date;

  constructor(options: LeaderboardServiceOptions) {
    this.#repo = new LeaderboardRepository(options.tenant);
    this.#now = options.now ?? (() => new Date());
  }

  /** One run's board, as this reader may see it. */
  async sessionBoard(sessionId: string, viewer: LeaderboardViewer): Promise<SessionLeaderboardView> {
    // A phone belongs to one run. Another run's board is not found, for the
    // reason EXPD-017 gives for answering 404 rather than 403.
    if (viewer.kind === 'device' && viewer.sessionId !== sessionId) {
      throw notFound('run');
    }
    const session = await this.#repo.findSession(sessionId);
    if (session === null) {
      throw notFound('run');
    }

    const [version] = await this.#repo.listVersions([session.expedition_version_id]);
    if (version === undefined) {
      throw new Error(`run ${session.id} is pinned to a revision that cannot be read`);
    }
    const config = leaderboardConfigOf(version);
    const final = isFinalSessionStatus(session.status);
    const shown = leaderboardShown(config.visibility, viewer.kind, final);
    const generatedAt = this.#now().toISOString();

    const base = {
      sessionId: session.id,
      sessionName: session.name,
      sessionStatus: session.status,
      visibility: config.visibility,
      tieBreaks: [...config.tieBreaks],
      final,
      shown,
      generatedAt,
    };
    if (!shown) {
      // Nothing about the teams is read at all when it cannot be shown.
      return { ...base, standings: [] };
    }

    const figures = await this.#figuresFor([session]);
    const members = await this.#membersOf(figures.map((team) => team.teamId));
    const standings: SessionStandingView[] = rankTeams(figures, config.tieBreaks).map(
      ({ rank, figures: team }) => ({
        ...standingOf(rank, team),
        members: members.get(team.teamId) ?? [],
      }),
    );

    return { ...base, standings };
  }

  /** Every run of an expedition that was played to the end, on one board. */
  async expeditionBoard(
    expeditionId: string,
    page: { readonly limit: number },
  ): Promise<ExpeditionLeaderboardView> {
    if (!(await this.#repo.expeditionExists(expeditionId))) {
      throw notFound('expedition');
    }
    const generatedAt = this.#now().toISOString();

    const ended = await this.#repo.listEndedSessions(expeditionId);
    const versions = await this.#repo.listVersions([
      ...new Set(ended.map((session) => session.expedition_version_id)),
    ]);
    const byId = new Map(versions.map((version) => [version.id, version]));

    // A run whose revision hides its board stays hidden here too.
    const sessions = ended.filter((session) => {
      const version = byId.get(session.expedition_version_id);
      return (
        version !== undefined && leaderboardConfigOf(version).visibility !== 'hidden'
      );
    });

    const tieBreaks = newestTieBreaks(
      sessions.map((session) => byId.get(session.expedition_version_id)),
    );

    const figures = sessions.length === 0 ? [] : await this.#figuresFor(sessions);
    const names = new Map(sessions.map((session) => [session.id, session.name]));
    const ranked = rankTeams(figures, tieBreaks);

    const standings: ExpeditionStandingView[] = ranked
      .slice(0, page.limit)
      .map(({ rank, figures: team }) => ({
        ...standingOf(rank, team),
        sessionId: team.sessionId,
        sessionName: names.get(team.sessionId) ?? '',
      }));

    return {
      expeditionId,
      sessionCount: sessions.length,
      tieBreaks: [...tieBreaks],
      generatedAt,
      total: ranked.length,
      limit: page.limit,
      standings,
    };
  }

  /** Every counted team in some runs, with the figures it is placed on. */
  async #figuresFor(sessions: readonly ExpeditionSessionRow[]): Promise<Figures[]> {
    const sessionIds = sessions.map((session) => session.id);
    const teams = await this.#repo.listTeams(sessionIds);
    if (teams.length === 0) {
      return [];
    }

    const [completions, hints, finishes] = await Promise.all([
      this.#repo.listCompletions(sessionIds),
      this.#repo.listHintsOpened(sessionIds),
      this.#repo.listFinishes(sessionIds),
    ]);

    // A mission is counted once however many lines say it was finished.
    const completed = new Map<string, Set<string>>();
    for (const row of completions) {
      const set = completed.get(row.team_id) ?? new Set<string>();
      set.add(row.mission_instance_key);
      completed.set(row.team_id, set);
    }

    const hintsUsed = new Map<string, number>();
    for (const row of hints) {
      hintsUsed.set(row.team_id, (hintsUsed.get(row.team_id) ?? 0) + 1);
    }

    const finishedAt = new Map<string, number>();
    for (const row of finishes) {
      const at = timeOf(row.occurred_at);
      const earlier = finishedAt.get(row.team_id);
      if (at !== null && (earlier === undefined || at < earlier)) {
        finishedAt.set(row.team_id, at);
      }
    }

    const startedAt = new Map(sessions.map((session) => [session.id, timeOf(session.started_at)]));

    return teams.map((team) => ({
      teamId: team.id,
      teamName: team.name,
      sessionId: team.expedition_session_id,
      totalScore: Number(team.total_score),
      missionsCompleted: completed.get(team.id)?.size ?? 0,
      hintsUsed: hintsUsed.get(team.id) ?? 0,
      failedAttempts: Number(team.failed_attempts ?? 0),
      finishSeconds: finishSecondsOf(
        team,
        finishedAt.get(team.id) ?? null,
        startedAt.get(team.expedition_session_id) ?? null,
      ),
    }));
  }

  /** The display names on some teams, in the order each member joined. */
  async #membersOf(teamIds: readonly string[]): Promise<Map<string, string[]>> {
    const byTeam = new Map<string, string[]>();
    if (teamIds.length === 0) {
      return byTeam;
    }
    const members = await this.#repo.listMembers(teamIds);
    if (members.length === 0) {
      return byTeam;
    }
    const participants = await this.#repo.listDisplayNames(
      members.map((member) => member.participant_id),
    );
    // A student taken out of the run, or who left it, is not on the board.
    const names = new Map(
      participants
        .filter((row) => row.status !== 'removed' && row.status !== 'left')
        .map((row) => [row.id, row.display_name]),
    );

    const ordered = [...members].sort(
      (a, b) => (timeOf(a.joined_at) ?? 0) - (timeOf(b.joined_at) ?? 0),
    );
    for (const member of ordered) {
      const name = names.get(member.participant_id);
      if (name === undefined) continue;
      const list = byTeam.get(member.team_id) ?? [];
      list.push(name);
      byTeam.set(member.team_id, list);
    }
    return byTeam;
  }
}

/** A team's line, without what differs between the two boards. */
function standingOf(rank: number, team: TeamFigures) {
  return {
    rank,
    teamId: team.teamId,
    teamName: team.teamName,
    totalScore: team.totalScore,
    missionsCompleted: team.missionsCompleted,
    hintsUsed: team.hintsUsed,
    failedAttempts: team.failedAttempts,
    finished: team.finishSeconds !== null,
    finishSeconds: team.finishSeconds,
  };
}

/**
 * The tie breaks of the newest revision among some runs.
 *
 * One board needs one order, and runs of the same expedition may be pinned to
 * different revisions. The newest revision is the author's latest word on how
 * ties are broken.
 */
function newestTieBreaks(
  versions: readonly (Pick<ExpeditionVersionRow, 'definition' | 'definition_version'> | undefined)[],
): readonly LeaderboardTieBreak[] {
  let newest: Pick<ExpeditionVersionRow, 'definition' | 'definition_version'> | undefined;
  for (const version of versions) {
    if (version !== undefined && (newest === undefined || version.definition_version > newest.definition_version)) {
      newest = version;
    }
  }
  return newest === undefined ? [] : leaderboardConfigOf(newest).tieBreaks;
}

/**
 * How long a team took to finish, from the start of its run.
 *
 * The finish is `team.finished_at` when something has set it, and otherwise
 * the first `expedition-finished` line in the team's stream (EXPD-014).
 */
function finishSecondsOf(
  team: LeaderboardTeamRow,
  streamFinish: number | null,
  runStart: number | null,
): number | null {
  const finish = timeOf(team.finished_at) ?? streamFinish;
  if (finish === null || runStart === null) {
    return null;
  }
  return Math.max(0, Math.round((finish - runStart) / 1000));
}

/** A stored time as milliseconds, or null. `pg` gives a `Date`; a test may give a string. */
function timeOf(value: Date | string | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isNaN(ms) ? null : ms;
}
