/**
 * The one place points are minted (EXPD-012).
 *
 * Every award in the engine goes through `award` below, and nothing anywhere
 * adds a number to a total by hand. That is what makes "every score change
 * writes a ScoreEvent" true by construction rather than by everybody
 * remembering: there is one function that can move a total, and it writes the
 * line at the same moment it moves it.
 *
 * Two limits live here, because both are about the award rather than about
 * the rule that asked for it:
 *
 *   1. **A mission's cap.** `MissionScoring.maxPoints` is the most one
 *      mission can ever add up to, bonuses included. Awards are applied in
 *      the order the document lists its rules, and the cap applies to
 *      whatever that mission has added up to by the time each one fires — so
 *      a speed bonus listed first can take the room a streak bonus wanted.
 *      That is the document's own wording, and it is why the order of
 *      `ScoringConfig.rules` is part of the answer.
 *   2. **The expedition's floor.** `ScoringConfig.minimumTotal` is the lowest
 *      a team can end on. A penalty that would go under it takes the team to
 *      the floor and no further.
 *
 * **A trimmed award is written down as what it actually moved**, with a
 * `limit` saying what it would have been. Writing down the untrimmed figure
 * would make a stream that no longer adds up to the total, and a stream that
 * does not add up is not a record of anything.
 *
 * **Nothing that moves the total by nought is written down.** A cap that eats
 * a bonus whole, a penalty on a team already at the floor, a mission worth
 * nought points: none of them is a score change, so none of them is a score
 * event. What a team is shown about a cap they hit is a screen (EXPD-045)
 * rather than a line in the record.
 */

import type {
  IsoTimestamp,
  ScoreEvent,
  ScoreEventReason,
  ScoreLimit,
} from '@explorer/shared-types';

/** What one award says about itself, beyond the number. */
export type AwardDetail = Omit<ScoreEvent, 'reason' | 'points' | 'at' | 'limit'>;

/**
 * A running total with the two limits around it.
 *
 * It is mutable and it is local: one is opened for one score change, the
 * events are taken off it, and it is thrown away. Nothing outside this file
 * holds one, and nothing holds one between calls, so the engine still keeps
 * no state of its own.
 */
export interface Ledger {
  /** The total as it stands, including everything awarded so far. */
  total: number;
  /** What this one mission has added up to, for the cap to measure. */
  missionSubtotal: number;
  /** The lines written, oldest first. */
  readonly events: ScoreEvent[];
  /** The lowest total the floor allows. */
  readonly minimumTotal: number;
  /** The most this mission may add up to, or `null` when it is uncapped. */
  readonly maxPoints: number | null;
}

/** Opens a ledger on a team's total. */
export function openLedger(
  total: number,
  minimumTotal: number,
  maxPoints: number | null,
): Ledger {
  return { total, missionSubtotal: 0, events: [], minimumTotal, maxPoints };
}

/**
 * Moves the total and writes the line, once both limits have had their say.
 *
 * `points` is signed: positive earns, negative takes away. Returns what
 * actually moved, which is nought when a limit left no room.
 */
export function award(
  ledger: Ledger,
  points: number,
  reason: ScoreEventReason,
  at: IsoTimestamp,
  detail: AwardDetail = {},
): number {
  if (!Number.isFinite(points) || points === 0) {
    return 0;
  }

  const wanted = Math.round(points);
  let moved = wanted;
  let limit: ScoreLimit | undefined;

  // The cap is about what a mission is worth, so it only ever trims an award
  // that adds to one. A penalty never runs into it.
  if (moved > 0 && ledger.maxPoints !== null) {
    const room = ledger.maxPoints - ledger.missionSubtotal;
    if (moved > room) {
      moved = Math.max(0, room);
      limit = { kind: 'mission-cap', wouldHaveBeen: wanted };
    }
  }

  // The floor is about the team's total, so it only ever trims a penalty.
  if (moved < 0 && ledger.total + moved < ledger.minimumTotal) {
    moved = Math.min(0, ledger.minimumTotal - ledger.total);
    limit = { kind: 'minimum-total', wouldHaveBeen: wanted };
  }

  if (moved === 0) {
    return 0;
  }

  ledger.total += moved;
  ledger.missionSubtotal += moved;
  ledger.events.push({
    reason,
    points: moved,
    at,
    ...detail,
    ...(limit === undefined ? {} : { limit }),
  });
  return moved;
}

/**
 * Adds a stream of score events up.
 *
 * This is the check the record exists for. Every event says what it actually
 * moved, so a team's total is the sum of their events and nothing else — no
 * rule has to be read, no document has to be to hand, and a total that
 * disagrees with the stream behind it is a total somebody wrote by hand.
 * `team.total_score` in migration 0001 is the same sum, kept so that a
 * leaderboard does not add it up on every read.
 */
export function scoreTotal(events: readonly ScoreEvent[]): number {
  let total = 0;
  for (const event of events) {
    total += event.points;
  }
  return total;
}
