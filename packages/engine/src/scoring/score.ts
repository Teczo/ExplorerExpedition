/**
 * The scoring engine (EXPD-012).
 *
 * What a verdict is worth. The completion interface (EXPD-011) says what a
 * team did; this says what it earned them, and writes the line saying so.
 *
 * ```ts
 * const result = applyScoreChange({
 *   kind: 'mission',
 *   score,
 *   verdict: completion.verdict,
 *   progress: completion.progress,
 *   mission: missionScoringPolicyFor(mission),
 *   scoring: expeditionScoringPolicyFor(definition),
 *   at: now,
 * });
 *
 * if (result.applied) {
 *   score = result.score;      // a new record; the old one stands
 *   store(result.events);      // every change, and why
 * } else {
 *   return reply.status(409).send({ refusal: result.refusal });
 * }
 * ```
 *
 * **Three things move a score, and there is one door.** A mission was judged,
 * a team spent a token on a hint, or a teacher moved the score by hand
 * (EXPD-058). Whichever it was, what comes back is either a new record and
 * the lines that got it there, or a refusal and a record that has not moved.
 *
 * **Every change writes a `ScoreEvent`, by construction.** Nothing here adds
 * a number to a total: every award goes through `award` in `ledger.ts`, which
 * writes the line at the moment it moves the total. Adding up a team's events
 * gives their total back, which is the whole point of keeping the stream.
 *
 * **It is told, the same way the state machine is.** Whether this team was
 * the first to finish a mission is a fact about every other team, and how
 * late the work was is a fact about the expedition's clock (EXPD-019). The
 * engine holds neither, so both arrive on the request. The alternative is a
 * scoring engine that needs the whole run in front of it to score one
 * mission, which is not a thing the simulation harness (EXPD-015) or a replay
 * could ever hold still.
 *
 * **It is pure.** No clock, no network, no state kept between calls. The same
 * request gives the same answer twice, which is what lets anybody re-check a
 * total a team is arguing with.
 *
 * **What it does not do.** It does not decide whether work was right: that is
 * EXPD-011, whose verdict it reads. It does not decide what a finished
 * mission unlocks: that is EXPD-013. It does not hand out hint tokens or
 * count how many are left: that is EXPD-046, and this is only what spending
 * one costs. It does not store anything and it holds no team id: carrying the
 * stream across the system is EXPD-014, and rows are EXPD-020's. And it does
 * not order or place teams: that is the leaderboard, EXPD-022.
 */

import type {
  CompletionVerdict,
  HintId,
  IsoTimestamp,
  MissionInstanceId,
  MissionProgress,
  ScoreEvent,
  ScoreRefusal,
  ScoreRefusalCode,
  ScoringRuleId,
  Seconds,
  TeamScore,
} from '@explorer/shared-types';

import { attemptStartedAt } from '../completion/timer.ts';
import {
  award,
  openLedger,
  scoreTotal,
  type AwardDetail,
  type Ledger,
} from './ledger.ts';
import {
  DEFAULT_EXPEDITION_SCORING_POLICY,
  DEFAULT_MISSION_SCORING_POLICY,
  missionsTargetedBy,
  targetCoversMission,
  type ExpeditionScoringPolicy,
  type MissionScoringPolicy,
} from './policy.ts';

/** What every score change carries, whichever of the three it is. */
interface ScoreChangeBase {
  /** Where the team stands on points now. */
  readonly score: TeamScore;
  /** When the caller is deciding it. Written into the events as given. */
  readonly at: IsoTimestamp;
  /** The expedition's rules and floor. Defaults to no rules and a floor of nought. */
  readonly scoring?: ExpeditionScoringPolicy;
}

/** A mission was judged (EXPD-011). */
export interface MissionScoreChange extends ScoreChangeBase {
  readonly kind: 'mission';
  /** What the completion interface concluded. */
  readonly verdict: CompletionVerdict;
  /**
   * The mission as it stands after the verdict.
   *
   * It is what says which mission this is about, which try it was, and — when
   * the caller does not say — how long the team took, read off the `start`
   * that opened the try the same way the completion interface reads it.
   */
  readonly progress: MissionProgress;
  /** What this mission is worth. Defaults to nothing. */
  readonly mission?: MissionScoringPolicy;
  /**
   * How long the team took, in seconds, measured from opening the mission.
   *
   * What a `speed-bonus` is measured against. Left out and it is worked out
   * from the mission's own history, which is right whenever the history has a
   * `start` in it. Pass it when it does not — a replay building one team's
   * score from stored rows, or a simulation run turning the dial.
   */
  readonly tookSeconds?: Seconds;
  /**
   * Whether this is the first team to finish this mission.
   *
   * A fact about every other team, so the engine is told it rather than
   * asking. False unless said otherwise, which is the safe way round: a bonus
   * nobody claimed is a smaller mistake than one every team claims.
   */
  readonly firstToComplete?: boolean;
  /**
   * How far past the expedition's time limit the work was, in seconds.
   *
   * What a `late-penalty` is measured against. The expedition's clock belongs
   * to the session (EXPD-019) and the engine holds no clock, so whoever owns
   * it passes the number in, and passes nothing when the work was on time or
   * when the expedition's `latePolicy` is not `accept-with-penalty`.
   */
  readonly lateBySeconds?: Seconds;
}

/** A team spent a token on a hint (EXPD-046). */
export interface HintScoreChange extends ScoreChangeBase {
  readonly kind: 'hint';
  /** The mission the hint is on, which is what a rule's target is matched to. */
  readonly missionInstanceId: MissionInstanceId;
  /** The hint, so the same one is never charged for twice. */
  readonly hintId: HintId;
}

/** A teacher moved the score by hand (EXPD-058). */
export interface AdjustmentScoreChange extends ScoreChangeBase {
  readonly kind: 'adjustment';
  /** How much to move it by. Positive gives, negative takes away. */
  readonly points: number;
  /**
   * Why, in the teacher's own words.
   *
   * Required, because `score_event` in migration 0001 says a hand adjustment
   * carries who made it, and a total a class will ask about should carry why
   * as well.
   */
  readonly note: string;
  /** The mission it was about, when it was about one. */
  readonly missionInstanceId?: MissionInstanceId;
}

/** One thing that could move a team's score. */
export type ScoreChange =
  | MissionScoreChange
  | HintScoreChange
  | AdjustmentScoreChange;

/** What came of putting one of those through the engine. */
export type ScoreResult =
  | {
      readonly applied: true;
      /** The record after the change. A new value; the old one is untouched. */
      readonly score: TeamScore;
      /**
       * The lines added, oldest first.
       *
       * Empty when nothing moved the total. A wrong answer on an expedition
       * with no `attempt-penalty` rule costs nothing and still breaks the
       * team's streak, so it is applied with nothing to write down.
       */
      readonly events: readonly ScoreEvent[];
    }
  | {
      readonly applied: false;
      /** The record, unchanged and with nothing added to it. */
      readonly score: TeamScore;
      readonly refusal: ScoreRefusal;
    };

/**
 * A team's score record, from a stream of events or from nothing at all.
 *
 * There is no way to hand it an opening total, on purpose: a total that did
 * not come from the events behind it is a total nobody can check, which is
 * the one thing keeping a stream is meant to prevent. A team rebuilt part way
 * through a run is rebuilt from its stored events (EXPD-014), and the total
 * that comes back is the sum of them.
 *
 * The running counts start at nothing whichever way it is built, because they
 * are not in the stream — the note on `TeamScore` says why, and what rebuilds
 * them is replaying the game rather than the score.
 */
export function createTeamScore(events: readonly ScoreEvent[] = []): TeamScore {
  return {
    total: scoreTotal(events),
    completedMissionIds: [],
    spentHintIds: [],
    awardedRuleIds: [],
    streak: 0,
    longestStreak: 0,
    failedAttempts: 0,
    events: [...events],
  };
}

function refuse(
  score: TeamScore,
  code: ScoreRefusalCode,
  message: string,
  extra: Omit<ScoreRefusal, 'code' | 'message'> = {},
): ScoreResult {
  return { applied: false, score, refusal: { code, message, ...extra } };
}

/**
 * How long the team was on the mission, in seconds.
 *
 * Measured from the `start` that opened the running try to the moment the
 * caller is scoring at, which is what `speed-bonus` means by "from opening
 * the mission". `undefined` when the history holds no start or holds a time
 * nobody can read, and a bonus that cannot be measured is not awarded.
 */
export function secondsOnMission(
  progress: MissionProgress,
  at: IsoTimestamp,
): Seconds | undefined {
  const startedAt = attemptStartedAt(progress);
  if (startedAt === undefined) {
    return undefined;
  }
  const started = Date.parse(startedAt);
  const ended = Date.parse(at);
  if (Number.isNaN(started) || Number.isNaN(ended) || ended < started) {
    return undefined;
  }
  return (ended - started) / 1000;
}

/** Keeps the mission type's progress figure inside the nought-to-one it promised. */
function shareOf(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * How many minutes past the grace period the work was.
 *
 * A part minute counts as a whole one, so that the grace period is the free
 * part and nothing after it is. A team one second past a grace period that
 * has already run is late.
 */
function minutesLate(lateBySeconds: Seconds, graceSeconds: Seconds): number {
  const past = lateBySeconds - graceSeconds;
  return past <= 0 ? 0 : Math.ceil(past / 60);
}

/** A mission was judged: base points first, then every rule in document order. */
function scoreMission(change: MissionScoreChange): ScoreResult {
  const { score, verdict, progress } = change;
  const missionInstanceId = progress.missionInstanceId;
  const mission = change.mission ?? DEFAULT_MISSION_SCORING_POLICY;
  const scoring = change.scoring ?? DEFAULT_EXPEDITION_SCORING_POLICY;

  // Nobody has decided yet, so there is nothing to pay for. The teacher's
  // decision arrives later as its own verdict, and that one is scored.
  if (verdict.outcome === 'needs-review') {
    return refuse(
      score,
      'not-decided',
      'This mission is waiting on a teacher, so there is nothing to score yet.',
      { missionInstanceId },
    );
  }

  // A finished mission is paid for once. A second verdict on it — two phones,
  // a queued submission replaying — changes nothing.
  if (score.completedMissionIds.includes(missionInstanceId)) {
    return refuse(
      score,
      'already-scored',
      'This team has already been scored for this mission.',
      { missionInstanceId },
    );
  }

  const finished = verdict.outcome === 'correct';
  const wrong = verdict.outcome === 'incorrect';
  const streak = finished ? score.streak + 1 : 0;
  const completedMissionIds = finished
    ? [...score.completedMissionIds, missionInstanceId]
    : score.completedMissionIds;

  const ledger = openLedger(score.total, scoring.minimumTotal, mission.maxPoints);
  const attemptNumber = progress.attemptsUsed;
  const on: AwardDetail = {
    missionInstanceId,
    ...(attemptNumber > 0 ? { attemptNumber } : {}),
  };

  if (finished) {
    // Partial credit is what the schema calls scoring an answer by how much
    // of it was right. The mission type is the only thing that knows how
    // much, and the mission's own `allowPartialCredit` is what decides
    // whether that figure is worth anything.
    const share = mission.allowPartialCredit ? shareOf(verdict.progress) : 1;
    if (share < 1) {
      award(ledger, mission.basePoints * share, 'partial-credit', change.at, {
        ...on,
        note: `${String(Math.round(share * 100))}% of this mission was right.`,
      });
    } else {
      award(ledger, mission.basePoints, 'mission-complete', change.at, {
        ...on,
        note: 'Mission complete.',
      });
    }
  }

  const took = change.tookSeconds ?? secondsOnMission(progress, change.at);
  const awardedRuleIds: ScoringRuleId[] = [];

  // In the order the document lists them, because a mission's cap applies to
  // whatever that mission has added up to by the time each one fires.
  for (const rule of scoring.rules) {
    const by: AwardDetail = { ...on, scoringRuleId: rule.id };

    switch (rule.type) {
      case 'speed-bonus': {
        if (!finished || took === undefined) {
          break;
        }
        if (!targetCoversMission(rule.target, missionInstanceId)) {
          break;
        }
        if (took > rule.withinSeconds) {
          break;
        }
        award(ledger, rule.points, 'speed-bonus', change.at, {
          ...by,
          note: `Finished inside ${String(rule.withinSeconds)} seconds.`,
        });
        break;
      }

      case 'first-to-complete-bonus': {
        if (!finished || change.firstToComplete !== true) {
          break;
        }
        if (!targetCoversMission(rule.target, missionInstanceId)) {
          break;
        }
        award(ledger, rule.points, 'first-to-complete-bonus', change.at, {
          ...by,
          note: 'First team to finish this one.',
        });
        break;
      }

      case 'streak-bonus': {
        // Every run of `length` pays, not only the first. A team six missions
        // into a streak of three has done the thing twice.
        if (!finished || streak < rule.length || streak % rule.length !== 0) {
          break;
        }
        award(ledger, rule.points, 'streak-bonus', change.at, {
          ...by,
          note: `${String(rule.length)} in a row.`,
        });
        break;
      }

      case 'completion-bonus': {
        if (!finished || score.awardedRuleIds.includes(rule.id)) {
          break;
        }
        const wanted = missionsTargetedBy(rule.target, scoring);
        if (wanted.length === 0) {
          break;
        }
        if (!wanted.every((id) => completedMissionIds.includes(id))) {
          break;
        }
        award(ledger, rule.points, 'completion-bonus', change.at, {
          ...by,
          note: `All ${String(wanted.length)} missions finished.`,
        });
        awardedRuleIds.push(rule.id);
        break;
      }

      case 'hint-penalty': {
        // A hint costs when it is opened, not when the mission ends, so that
        // a team is charged at the moment they choose to pay.
        break;
      }

      case 'attempt-penalty': {
        if (!wrong || !targetCoversMission(rule.target, missionInstanceId)) {
          break;
        }
        award(ledger, -rule.pointsPerFailedAttempt, 'attempt-penalty', change.at, {
          ...by,
          note: 'Wrong answer.',
        });
        break;
      }

      case 'late-penalty': {
        // Only work that finished a mission is charged for being late. A
        // wrong answer handed in late has already cost the team an attempt
        // penalty, and charging twice for one submission is not what the
        // expedition's `accept-with-penalty` says.
        if (!finished || change.lateBySeconds === undefined) {
          break;
        }
        const minutes = minutesLate(change.lateBySeconds, rule.graceSeconds);
        if (minutes === 0) {
          break;
        }
        award(ledger, -(rule.pointsPerMinute * minutes), 'late-penalty', change.at, {
          ...by,
          note: `${String(minutes)} minute${minutes === 1 ? '' : 's'} past the time limit.`,
        });
        break;
      }
    }
  }

  return {
    applied: true,
    score: {
      total: ledger.total,
      completedMissionIds,
      spentHintIds: score.spentHintIds,
      awardedRuleIds:
        awardedRuleIds.length === 0
          ? score.awardedRuleIds
          : [...score.awardedRuleIds, ...awardedRuleIds],
      streak,
      longestStreak: Math.max(score.longestStreak, streak),
      failedAttempts: wrong ? score.failedAttempts + 1 : score.failedAttempts,
      events: [...score.events, ...ledger.events],
    },
    events: ledger.events,
  };
}

/** A hint was opened: every `hint-penalty` rule that names the mission charges. */
function scoreHint(change: HintScoreChange): ScoreResult {
  const { score, hintId, missionInstanceId } = change;
  const scoring = change.scoring ?? DEFAULT_EXPEDITION_SCORING_POLICY;

  if (score.spentHintIds.includes(hintId)) {
    return refuse(
      score,
      'hint-already-spent',
      'This team has already paid for this hint.',
      { missionInstanceId, hintId },
    );
  }

  // No cap: a mission's `maxPoints` is the most the mission can be worth, and
  // a hint a team chose to open is a cost against their total rather than a
  // part of what the mission is worth.
  const ledger = openLedger(score.total, scoring.minimumTotal, null);

  for (const rule of scoring.rules) {
    if (rule.type !== 'hint-penalty') {
      continue;
    }
    if (!targetCoversMission(rule.target, missionInstanceId)) {
      continue;
    }
    award(ledger, -rule.pointsPerHint, 'hint-penalty', change.at, {
      missionInstanceId,
      hintId,
      scoringRuleId: rule.id,
      note: 'Hint opened.',
    });
  }

  return {
    applied: true,
    score: {
      ...score,
      total: ledger.total,
      // A hint is counted as spent whether or not a rule charged for it: the
      // `fewest-hints-used` tie break (EXPD-022) counts hints, not points.
      spentHintIds: [...score.spentHintIds, hintId],
      events: [...score.events, ...ledger.events],
    },
    events: ledger.events,
  };
}

/** A teacher moved the score by hand: one line, in their own words. */
function scoreAdjustment(change: AdjustmentScoreChange): ScoreResult {
  const { score } = change;
  const scoring = change.scoring ?? DEFAULT_EXPEDITION_SCORING_POLICY;
  const ledger: Ledger = openLedger(score.total, scoring.minimumTotal, null);

  award(ledger, change.points, 'manual-adjustment', change.at, {
    note: change.note,
    ...(change.missionInstanceId === undefined
      ? {}
      : { missionInstanceId: change.missionInstanceId }),
  });

  return {
    applied: true,
    score: {
      ...score,
      total: ledger.total,
      events: [...score.events, ...ledger.events],
    },
    events: ledger.events,
  };
}

/**
 * Works out what one thing was worth, and moves the team's score if it was
 * worth anything.
 *
 * The one entry point. Whatever came in, what comes back is either a new
 * record and the lines that got it there, or a refusal and a record that has
 * not moved.
 */
export function applyScoreChange(change: ScoreChange): ScoreResult {
  switch (change.kind) {
    case 'mission':
      return scoreMission(change);
    case 'hint':
      return scoreHint(change);
    case 'adjustment':
      return scoreAdjustment(change);
  }
}
