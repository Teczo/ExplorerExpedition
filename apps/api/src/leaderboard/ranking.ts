/**
 * Placing teams in order (EXPD-022).
 *
 * The scoring engine (EXPD-012) says what each team earned and deliberately
 * stops there: "it does not order or place teams: that is the leaderboard".
 * This is that half. It takes figures that are already worked out and puts
 * them in order. It reads nothing and it writes nothing.
 *
 * The order is the one `LeaderboardConfig` describes:
 *
 *   1. The higher total first.
 *   2. Then each tie break the expedition names, tried in the order it names
 *      them.
 *   3. Teams still equal after every tie break **share a place**, as the
 *      config says they do. Places are counted the way a sports table counts
 *      them: two teams on 1st, and the next team is 3rd.
 *
 * Teams that share a place are still listed in a fixed order — by name, then
 * by id — so that two reads of the same figures draw the same table. That
 * order is for drawing only and never decides a place.
 */

import type { LeaderboardTieBreak } from '@explorer/shared-types';

/** What one team is placed on. */
export interface TeamFigures {
  readonly teamId: string;
  readonly teamName: string;
  readonly totalScore: number;
  /** Missions the team finished. */
  readonly missionsCompleted: number;
  /** Hints the team opened. */
  readonly hintsUsed: number;
  /** Wrong answers the team gave. */
  readonly failedAttempts: number;
  /**
   * Seconds from the start of the team's run to the moment it finished the
   * expedition. Null when it has not finished.
   *
   * A duration rather than a time of day, so that teams from two runs of the
   * same expedition can be compared: 10:40 on Tuesday and 14:05 on Thursday
   * say nothing about who was quicker.
   */
  readonly finishSeconds: number | null;
}

/** One team, and the place it came. */
export interface Placed<TFigures extends TeamFigures> {
  /** 1 is first. Teams that share a place share a number. */
  readonly rank: number;
  readonly figures: TFigures;
}

/**
 * Compares two teams on one tie break.
 *
 * Negative when `a` is placed higher. A team that has not finished is placed
 * below every team that has, for `earliest-finish`.
 */
function compareOn(tieBreak: LeaderboardTieBreak, a: TeamFigures, b: TeamFigures): number {
  switch (tieBreak) {
    case 'earliest-finish':
      if (a.finishSeconds === null && b.finishSeconds === null) return 0;
      if (a.finishSeconds === null) return 1;
      if (b.finishSeconds === null) return -1;
      return a.finishSeconds - b.finishSeconds;
    case 'most-missions-completed':
      return b.missionsCompleted - a.missionsCompleted;
    case 'fewest-hints-used':
      return a.hintsUsed - b.hintsUsed;
    case 'fewest-failed-attempts':
      return a.failedAttempts - b.failedAttempts;
  }
}

/** Compares two teams on everything that decides a place. Zero means they share one. */
export function compareTeams(
  a: TeamFigures,
  b: TeamFigures,
  tieBreaks: readonly LeaderboardTieBreak[],
): number {
  if (a.totalScore !== b.totalScore) {
    return b.totalScore - a.totalScore;
  }
  for (const tieBreak of tieBreaks) {
    const compared = compareOn(tieBreak, a, b);
    if (compared !== 0) {
      return compared;
    }
  }
  return 0;
}

/** Puts teams in order and gives each its place. */
export function rankTeams<TFigures extends TeamFigures>(
  teams: readonly TFigures[],
  tieBreaks: readonly LeaderboardTieBreak[],
): Placed<TFigures>[] {
  const ordered = [...teams].sort(
    (a, b) =>
      compareTeams(a, b, tieBreaks) ||
      a.teamName.localeCompare(b.teamName) ||
      a.teamId.localeCompare(b.teamId),
  );

  const placed: Placed<TFigures>[] = [];
  ordered.forEach((figures, index) => {
    const previous = placed[index - 1];
    const shares =
      previous !== undefined && compareTeams(previous.figures, figures, tieBreaks) === 0;
    placed.push({ rank: shares ? previous.rank : index + 1, figures });
  });
  return placed;
}
