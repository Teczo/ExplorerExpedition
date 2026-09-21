/**
 * Rebuilding a final result from the record behind it (EXPD-014).
 *
 * The other half of what makes a result disputable. Checking a stream
 * (`verify.ts`) says the record is what was written; this says what the
 * record comes to. Between them, a team told they finished on 340 can be
 * handed the lines, work the 340 out themselves, and point at the line they
 * disagree with.
 *
 * ```ts
 * const result = replayStream(entries);
 * result.total;            // the same 340, from the stream and nothing else
 * result.pointsByReason;   // where it came from, in ten numbers
 * result.missions;         // and per mission, which is the argument they have
 * ```
 *
 * **Nothing is read but the stream.** No expedition document, no scoring
 * rule, no other team, no clock. That is what lets a result be rebuilt a year
 * later, after the document has been edited twice and the session archived,
 * and still come out the same.
 *
 * **It reads the record; it does not re-judge it.** Whether a `speed-bonus`
 * of 25 should have been awarded at all is a question about the rules, and
 * running the rules over a run again is the simulation harness (EXPD-015).
 * This says the 25 is in the record, which line put it there, and what the
 * total is with it in.
 *
 * **What is not in the stream is not in the result.** The streak, the failed
 * attempts and the hints spent are the engine's running counts rather than
 * score changes — `TeamScore` says why — so `replayTeamScore` below hands
 * back a record with the total and the events right and those three at
 * nought, which is exactly what `createTeamScore` promises.
 */

import { createTeamScore } from '../scoring/index.ts';
import {
  isProgressionEntry,
  isScoreEntry,
  type IsoTimestamp,
  type MissionInstanceId,
  type MissionResult,
  type NodeId,
  type ScoreEvent,
  type ScoreEventReason,
  type StreamEntry,
  type StreamResult,
  type TeamScore,
} from '@explorer/shared-types';

/** What one mission came to, while it is still being added up. */
interface MissionTally {
  points: number;
  lines: number;
  unlocked: boolean;
  revealed: boolean;
  firstAt?: IsoTimestamp;
  lastAt?: IsoTimestamp;
}

/** Adds an id to a list the first time it is seen, keeping the order. */
function remember<TId>(seen: Set<TId>, order: TId[], id: TId): void {
  if (!seen.has(id)) {
    seen.add(id);
    order.push(id);
  }
}

/** The tally for one mission, made the first time a line names it. */
function tallyFor(
  tallies: Map<MissionInstanceId, MissionTally>,
  missionInstanceId: MissionInstanceId,
): MissionTally {
  const existing = tallies.get(missionInstanceId);
  if (existing !== undefined) {
    return existing;
  }
  const made: MissionTally = { points: 0, lines: 0, unlocked: false, revealed: false };
  tallies.set(missionInstanceId, made);
  return made;
}

/** Widens a tally's window of time to take one more line in. */
function noteTime(tally: MissionTally, at: IsoTimestamp): void {
  tally.firstAt ??= at;
  tally.lastAt = at;
}

/**
 * What a team's stream comes to.
 *
 * The lines are read in the order they are given, which is the order they
 * were sealed in. A stream nobody has checked still replays — the arithmetic
 * is the same whatever the seals say — so a caller who cares whether the
 * record is genuine runs `verifyStream` as well, and a caller only drawing a
 * results screen need not.
 */
export function replayStream(entries: readonly StreamEntry[]): StreamResult {
  const pointsByReason: Partial<Record<ScoreEventReason, number>> = {};
  const tallies = new Map<MissionInstanceId, MissionTally>();
  const missionOrder: MissionInstanceId[] = [];
  const missionSeen = new Set<MissionInstanceId>();

  const reachedSeen = new Set<NodeId>();
  const reachedNodeIds: NodeId[] = [];
  const clearedSeen = new Set<NodeId>();
  const clearedNodeIds: NodeId[] = [];
  const unlockedSeen = new Set<MissionInstanceId>();
  const unlockedMissionIds: MissionInstanceId[] = [];
  const revealedSeen = new Set<MissionInstanceId>();
  const revealedMissionIds: MissionInstanceId[] = [];

  let total = 0;
  let finished = false;
  let finishedAt: IsoTimestamp | undefined;
  let startedAt: IsoTimestamp | undefined;
  let endedAt: IsoTimestamp | undefined;

  for (const entry of entries) {
    const at = entry.event.at;
    startedAt ??= at;
    endedAt = at;

    if (isScoreEntry(entry)) {
      const event = entry.event;
      total += event.points;
      pointsByReason[event.reason] = (pointsByReason[event.reason] ?? 0) + event.points;

      if (event.missionInstanceId !== undefined) {
        remember(missionSeen, missionOrder, event.missionInstanceId);
        const tally = tallyFor(tallies, event.missionInstanceId);
        tally.points += event.points;
        tally.lines += 1;
        noteTime(tally, at);
      }
      continue;
    }

    if (isProgressionEntry(entry)) {
      const event = entry.event;
      const nodeId = event.nodeId;
      const missionInstanceId = event.missionInstanceId;

      if (missionInstanceId !== undefined) {
        remember(missionSeen, missionOrder, missionInstanceId);
        noteTime(tallyFor(tallies, missionInstanceId), at);
      }

      switch (event.reason) {
        case 'node-reached':
          if (nodeId !== undefined) {
            remember(reachedSeen, reachedNodeIds, nodeId);
          }
          break;
        case 'node-cleared':
          if (nodeId !== undefined) {
            remember(clearedSeen, clearedNodeIds, nodeId);
          }
          break;
        case 'mission-unlocked':
          if (missionInstanceId !== undefined) {
            remember(unlockedSeen, unlockedMissionIds, missionInstanceId);
            tallyFor(tallies, missionInstanceId).unlocked = true;
          }
          break;
        case 'mission-revealed':
          if (missionInstanceId !== undefined) {
            remember(revealedSeen, revealedMissionIds, missionInstanceId);
            tallyFor(tallies, missionInstanceId).revealed = true;
          }
          break;
        case 'expedition-finished':
          finished = true;
          finishedAt ??= at;
          if (nodeId !== undefined) {
            remember(reachedSeen, reachedNodeIds, nodeId);
          }
          break;
      }
    }
  }

  const missions: MissionResult[] = missionOrder.map((missionInstanceId) => {
    const tally = tallyFor(tallies, missionInstanceId);
    return {
      missionInstanceId,
      points: tally.points,
      lines: tally.lines,
      unlocked: tally.unlocked,
      revealed: tally.revealed,
      ...(tally.firstAt === undefined ? {} : { firstAt: tally.firstAt }),
      ...(tally.lastAt === undefined ? {} : { lastAt: tally.lastAt }),
    };
  });

  return {
    total,
    pointsByReason,
    missions,
    reachedNodeIds,
    clearedNodeIds,
    unlockedMissionIds,
    revealedMissionIds,
    finished,
    ...(finishedAt === undefined ? {} : { finishedAt }),
    lines: entries.length,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(endedAt === undefined ? {} : { endedAt }),
  };
}

/** Every score change in a stream, oldest first, with the envelopes taken off. */
export function scoreEventsOf(
  entries: readonly StreamEntry[],
): readonly ScoreEvent[] {
  return entries.filter(isScoreEntry).map((entry) => entry.event);
}

/**
 * A team's score record, rebuilt from their stream.
 *
 * What EXPD-020 will hand `applyScoreChange` when it picks a run back up part
 * way through: the total is the sum of the stream, exactly, and the three
 * running counts start at nought because they were never in the stream to
 * begin with. Rebuilding those means replaying the game (EXPD-015), not the
 * score.
 */
export function replayTeamScore(entries: readonly StreamEntry[]): TeamScore {
  return createTeamScore(scoreEventsOf(entries));
}

/**
 * Every line that named one mission, in the order they were written.
 *
 * The answer to the argument a class actually has, which is never about the
 * total and always about one mission.
 */
export function streamLinesForMission(
  entries: readonly StreamEntry[],
  missionInstanceId: MissionInstanceId,
): readonly StreamEntry[] {
  return entries.filter((entry) => entry.event.missionInstanceId === missionInstanceId);
}
