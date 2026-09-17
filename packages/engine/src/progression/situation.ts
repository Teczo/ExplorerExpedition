/**
 * What the engine is told about one team (EXPD-013).
 *
 * An unlock condition can ask four things: has a mission been finished, what
 * has one earned, what is the team's total, and how long have they been
 * playing. The engine holds none of them. Where a team stands on a mission is
 * the state machine's record (EXPD-010), what they have earned is the scoring
 * engine's (EXPD-012), and the clock belongs to the session (EXPD-019).
 *
 * So progression is told, the same way the scoring engine is told whether a
 * team was first to finish. Whoever owns those three things builds one of
 * these and hands it over. The alternative is a progression engine that needs
 * the whole run in front of it to answer one question, which is not something
 * the simulation harness (EXPD-015) or a replay could hold still.
 *
 * It is a plain value. Building one from stored rows is EXPD-020's; building
 * one in a test is `teamSituation` below.
 */

import type {
  MissionInstanceId,
  MissionProgress,
  MissionState,
  RouteId,
  ScoreEvent,
  Seconds,
  TeamScore,
} from '@explorer/shared-types';

/** Everything an unlock condition may ask about one team. */
export interface TeamSituation {
  /**
   * Where the team stands on every mission there is a record of.
   *
   * A mission with no record here reads as `locked`, which is what a mission
   * the team has never got to looks like.
   */
  readonly missionStates: ReadonlyMap<MissionInstanceId, MissionState>;
  /**
   * What each mission has earned the team so far.
   *
   * What `mission-score-at-least` is measured against. A mission with no
   * entry has earned nothing. It is a sum of score events rather than a
   * number anybody keeps, for the reason EXPD-012 gives about totals: a
   * figure that did not come from the stream behind it is one nobody can
   * check.
   */
  readonly missionPoints: ReadonlyMap<MissionInstanceId, number>;
  /** The team's total. What `total-score-at-least` is measured against. */
  readonly totalPoints: number;
  /**
   * How long the team has been playing, in seconds.
   *
   * What `elapsed-time-at-least` is measured against. Measured from the
   * moment the team started, which is the session's to decide (EXPD-019),
   * because `StartMode` says teams may start together or one at a time.
   */
  readonly elapsedSeconds: Seconds;
  /**
   * The routes this team is on.
   *
   * Empty means the team is on no named route, so only edges that are for
   * everybody will let them through. Which route a team is on is decided when
   * teams are made (EXPD-018).
   */
  readonly routeIds: readonly RouteId[];
}

/** A team that has done nothing, earned nothing and is on no route. */
export const EMPTY_TEAM_SITUATION: TeamSituation = {
  missionStates: new Map(),
  missionPoints: new Map(),
  totalPoints: 0,
  elapsedSeconds: 0,
  routeIds: [],
};

/**
 * What each mission has earned a team, read off the score stream.
 *
 * Every event that names a mission counts towards that mission, whatever
 * moved it: the base points, a speed bonus on it, the penalty for a wrong
 * answer, the hint the team opened on it. That is what "what this mission has
 * earned us" means to a team looking at the board, and it is the only figure
 * the stream can be held to.
 *
 * Events that name no mission — a teacher's adjustment to the run as a whole —
 * count towards the total and towards no mission, which is where they belong.
 */
export function missionPointsFrom(
  events: readonly ScoreEvent[],
): Map<MissionInstanceId, number> {
  const points = new Map<MissionInstanceId, number>();
  for (const event of events) {
    const missionInstanceId = event.missionInstanceId;
    if (missionInstanceId === undefined) {
      continue;
    }
    points.set(missionInstanceId, (points.get(missionInstanceId) ?? 0) + event.points);
  }
  return points;
}

/** What the engine is told, when it is being told the whole of it. */
export interface TeamSituationInput {
  /** Where the team stands on every mission it has a record for. */
  readonly missions?: readonly MissionProgress[];
  /** Where the team stands on points (EXPD-012). */
  readonly score?: TeamScore;
  /** How long the team has been playing, in seconds. */
  readonly elapsedSeconds?: Seconds;
  /** The routes the team is on. */
  readonly routeIds?: readonly RouteId[];
}

/**
 * Builds a situation out of the two records a team already has.
 *
 * The mission states come off the state machine's records and the points come
 * off the score's event stream, so that neither is copied out by hand at the
 * call site. What is left — the clock and the route — is not in either
 * record, and is passed in.
 */
export function teamSituation(input: TeamSituationInput = {}): TeamSituation {
  const missionStates = new Map<MissionInstanceId, MissionState>();
  for (const progress of input.missions ?? []) {
    missionStates.set(progress.missionInstanceId, progress.state);
  }
  return {
    missionStates,
    missionPoints: missionPointsFrom(input.score?.events ?? []),
    totalPoints: input.score?.total ?? 0,
    elapsedSeconds: input.elapsedSeconds ?? 0,
    routeIds: input.routeIds ?? [],
  };
}

/** Where one mission stands for this team, or `locked` when there is no record. */
export function missionStateIn(
  situation: TeamSituation,
  missionInstanceId: MissionInstanceId,
): MissionState {
  return situation.missionStates.get(missionInstanceId) ?? 'locked';
}

/** What one mission has earned this team, or nothing when it has earned none. */
export function missionPointsIn(
  situation: TeamSituation,
  missionInstanceId: MissionInstanceId,
): number {
  return situation.missionPoints.get(missionInstanceId) ?? 0;
}
