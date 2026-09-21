/**
 * What a simulated run comes back with (EXPD-015).
 *
 * Three readers, three halves of the same report. A test wants the per-team
 * detail — which missions ended how, and the sealed stream to check. An
 * author planning an afternoon wants `duration`. The AI builder (EXPD-066)
 * wants `findings`: the short list of things about this expedition that would
 * go wrong on the day.
 *
 * Everything here is a plain value that survives a round trip through JSON,
 * the same rule every record in this package follows, because a report is
 * sent over an API and drawn in a browser.
 *
 * **A report says what happened in this run, not what is true of every run.**
 * A finding is evidence, and its wording says so: teams that were given no
 * way to finish, a mission nobody got to, a run that ran out of steps. How
 * strong the evidence is depends on how many teams were run and what their
 * dials were set to, and a caller that wants certainty runs more of them.
 */

import type {
  IsoTimestamp,
  MissionInstanceId,
  MissionProgress,
  MissionState,
  NodeId,
  ProgressionSnapshot,
  RouteId,
  Seconds,
  StreamEntry,
  TeamScore,
} from '@explorer/shared-types';

import type { SimulatedTeamId } from './teams.ts';

/** Why a team stopped playing. */
export type SimulationStop =
  /** They reached a finish node. */
  | 'finished'
  /** Nothing was open to them and they had not finished. */
  | 'stuck'
  /** They used every step the run allowed. */
  | 'step-budget'
  /** They used every second the run allowed. */
  | 'time-budget';

/** Something the engine would not do, kept so the report can say why. */
export interface SimulationRefusal {
  /** Which team it happened to. */
  readonly teamId: SimulatedTeamId;
  /** Which door turned it away. */
  readonly from: 'completion' | 'score' | 'transition';
  /** The refusal's own code, as the engine gave it. */
  readonly code: string;
  /** The refusal's own message. */
  readonly message: string;
  /** How far into the run it happened. */
  readonly atSeconds: Seconds;
  /** The mission it was about, when it was about one. */
  readonly missionInstanceId?: MissionInstanceId;
}

/** How one mission went for one team. */
export interface SimulatedMissionResult {
  readonly missionInstanceId: MissionInstanceId;
  /** The stop it sits on, when the graph holds one for it. */
  readonly nodeId?: NodeId;
  /** Where it ended up. */
  readonly state: MissionState;
  /** How many tries the team opened. */
  readonly attemptsUsed: number;
  /** How long the team spent on it, in seconds, travel included. */
  readonly secondsSpent: Seconds;
  /** How far into the run the team first opened it. */
  readonly startedAtSeconds?: Seconds;
  /** How far into the run it ended, however it ended. */
  readonly endedAtSeconds?: Seconds;
  /** What it earned them, hints and penalties on it included. */
  readonly points: number;
  /** How many hints they opened on it. */
  readonly hintsOpened: number;
}

/** How the whole expedition went for one team. */
export interface SimulatedTeamResult {
  readonly teamId: SimulatedTeamId;
  readonly routeIds: readonly RouteId[];
  /** Whether they reached a finish node. */
  readonly finished: boolean;
  readonly stop: SimulationStop;
  /** How long the whole run took them, in seconds. */
  readonly elapsedSeconds: Seconds;
  /** How many actions the run spent on them. */
  readonly steps: number;
  /** What they ended on. */
  readonly totalPoints: number;
  readonly completedMissionIds: readonly MissionInstanceId[];
  readonly failedMissionIds: readonly MissionInstanceId[];
  readonly skippedMissionIds: readonly MissionInstanceId[];
  /** The missions the graph never let them get to. */
  readonly unreachedMissionIds: readonly MissionInstanceId[];
  /** Every mission the team has a record of, in document order. */
  readonly missions: readonly SimulatedMissionResult[];
  /** Where they stood on the graph when they stopped. */
  readonly snapshot: ProgressionSnapshot;
  /** Where they stood on points, events and all (EXPD-012). */
  readonly score: TeamScore;
  /** The state machine's record of every mission (EXPD-010). */
  readonly missionProgress: readonly MissionProgress[];
  /**
   * Their sealed event stream (EXPD-014).
   *
   * The same lines the API would have written, in the same order, sealed the
   * same way — so a test can run `verifyStream` and `replayStream` over a
   * simulated run and hold the engine to its own record.
   */
  readonly stream: readonly StreamEntry[];
  /** Everything the engine turned away while they played. */
  readonly refusals: readonly SimulationRefusal[];
}

/** How long the expedition took, over the teams that finished it. */
export interface SimulationDuration {
  /** How many teams were run. */
  readonly teamsRun: number;
  /** How many of them reached a finish. */
  readonly teamsFinished: number;
  /** The quickest finishing team's time, in seconds. */
  readonly shortestSeconds?: Seconds;
  /** The slowest finishing team's time. */
  readonly longestSeconds?: Seconds;
  /** The middle one. With an even number of teams, the mean of the middle two. */
  readonly medianSeconds?: Seconds;
  /** The mean over the finishing teams. */
  readonly meanSeconds?: Seconds;
  /**
   * How long the teams that did not finish had played when they stopped.
   *
   * A floor rather than an estimate: whatever the expedition takes, it takes
   * at least this long. It is here so that a report over an expedition nobody
   * finished still says something about its length.
   */
  readonly unfinishedSeconds?: Seconds;
}

/** What is wrong with the expedition, or with the run. */
export type SimulationFindingCode =
  /** The graph has no start node, so no team can begin. */
  | 'no-start-node'
  /** The graph has no finish node, so no team can end. */
  | 'no-finish-node'
  /** Not one team reached a finish. */
  | 'no-team-finished'
  /** A team ran out of open missions without finishing. */
  | 'team-stuck'
  /** No team ever got to this mission. */
  | 'mission-never-reached'
  /** Teams got to this mission and not one of them finished it. */
  | 'mission-never-completed'
  /** No team ever got to this stop. */
  | 'node-never-reached'
  /** A team used every step the run allowed, so their run is cut short. */
  | 'step-budget-spent'
  /** A team used every second the run allowed. */
  | 'time-budget-spent'
  /** A mission names a type no registry could hold. */
  | 'unknown-mission-type'
  /** The engine turned a submission away, and the run could not go on. */
  | 'submission-refused'
  /**
   * A mission type was played with the sampling player.
   *
   * Its behaviour judged a payload built from its own schema rather than a
   * real answer, so what the run says about that mission is about the harness
   * and not about the expedition.
   */
  | 'sampled-mission-type';

/** How much a finding matters. */
export type SimulationFindingSeverity =
  /** The expedition cannot be played as written. */
  | 'error'
  /** It can, and something in it probably is not what the author meant. */
  | 'warning'
  /** Something about this run rather than about the expedition. */
  | 'note';

/** One thing the run found. */
export interface SimulationFinding {
  readonly code: SimulationFindingCode;
  readonly severity: SimulationFindingSeverity;
  /** A sentence an author can read, with no jargon and no ids in it. */
  readonly message: string;
  readonly missionInstanceId?: MissionInstanceId;
  readonly nodeId?: NodeId;
  readonly teamId?: SimulatedTeamId;
  /** The mission type it is about, as `key@version`. */
  readonly missionTypeRef?: string;
}

/** How the run judged what a team handed in. */
export type SimulationJudging =
  /** With stand-in mission types, so the team's skill decides (`scripted.ts`). */
  | 'scripted'
  /** With the registry's real behaviours and a player per type. */
  | 'behaviour';

/** What one simulated run came to. */
export interface SimulationReport {
  /** The seed the run was played with. The same one replays it exactly. */
  readonly seed: string;
  /** When the run began, as every timestamp in it is measured from. */
  readonly startedAt: IsoTimestamp;
  readonly judging: SimulationJudging;
  /** One entry per team, in the order the teams were given. */
  readonly teams: readonly SimulatedTeamResult[];
  readonly duration: SimulationDuration;
  /** Errors first, then warnings, then notes. */
  readonly findings: readonly SimulationFinding[];
  /** Whether any finding is an `error`. */
  readonly playable: boolean;
}

/** The middle of a list of numbers, or `undefined` when it is empty. */
export function medianOf(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  const upper = sorted[middle];
  if (upper === undefined) {
    return undefined;
  }
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1];
  return lower === undefined ? upper : Math.round((lower + upper) / 2);
}

/** How long the run took, worked out from the teams that played it. */
export function durationOf(teams: readonly SimulatedTeamResult[]): SimulationDuration {
  const finished = teams.filter((team) => team.finished).map((team) => team.elapsedSeconds);
  const unfinished = teams.filter((team) => !team.finished).map((team) => team.elapsedSeconds);

  const total = finished.reduce((sum, seconds) => sum + seconds, 0);
  const median = medianOf(finished);

  return {
    teamsRun: teams.length,
    teamsFinished: finished.length,
    ...(finished.length === 0
      ? {}
      : {
          shortestSeconds: Math.min(...finished),
          longestSeconds: Math.max(...finished),
          meanSeconds: Math.round(total / finished.length),
        }),
    ...(median === undefined ? {} : { medianSeconds: median }),
    ...(unfinished.length === 0 ? {} : { unfinishedSeconds: Math.max(...unfinished) }),
  };
}
