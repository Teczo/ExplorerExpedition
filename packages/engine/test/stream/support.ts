/**
 * What the stream tests are played against.
 *
 * The stream does not read a document, a rule or a clock, so nothing here
 * builds one. It needs score events and progression events, and a way to make
 * both without writing out every optional field each time.
 */

import type {
  MissionInstanceId,
  NodeId,
  ProgressionEvent,
  ProgressionEventReason,
  ProgressionMission,
  ProgressionNode,
  ProgressionSnapshot,
  ScoreEvent,
  ScoreEventReason,
} from '@explorer/shared-types';

/** A time, so that a test never has to write one out. */
export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 4, 12, 10, 0, seconds)).toISOString();
}

/** A mission id, tagged. */
export function missionId(name: string): MissionInstanceId {
  return name as MissionInstanceId;
}

/** A node id, tagged. */
export function nodeId(name: string): NodeId {
  return name as NodeId;
}

/** A score change, with only the fields a test cares about. */
export function scored(
  reason: ScoreEventReason,
  points: number,
  over: Partial<ScoreEvent> = {},
): ScoreEvent {
  return { reason, points, at: at(0), ...over };
}

/** A progression change, likewise. */
export function progressed(
  reason: ProgressionEventReason,
  over: Partial<ProgressionEvent> = {},
): ProgressionEvent {
  return { reason, at: at(0), ...over };
}

/** One stop in a snapshot, with everything off unless a test turns it on. */
export function node(
  name: string,
  over: Partial<ProgressionNode> = {},
): ProgressionNode {
  return {
    nodeId: nodeId(name),
    kind: 'mission',
    reached: false,
    cleared: false,
    offRoute: false,
    blockedBy: [],
    ...over,
  };
}

/** One mission in a snapshot, likewise. */
export function mission(
  name: string,
  over: Partial<ProgressionMission> = {},
): ProgressionMission {
  return {
    missionInstanceId: missionId(name),
    nodeId: nodeId(`${name}-stop`),
    state: 'locked',
    reached: false,
    unlocked: false,
    visible: true,
    optional: false,
    secret: false,
    offRoute: false,
    blockedBy: [],
    ...over,
  };
}

/** A snapshot built from the stops and missions a test names. */
export function snapshot(
  nodes: readonly ProgressionNode[],
  missions: readonly ProgressionMission[],
  over: Partial<ProgressionSnapshot> = {},
): ProgressionSnapshot {
  return {
    nodes,
    missions,
    unlockedMissionIds: missions
      .filter((each) => each.unlocked)
      .map((each) => each.missionInstanceId),
    visibleMissionIds: missions
      .filter((each) => each.visible)
      .map((each) => each.missionInstanceId),
    reachedFinishNodeIds: [],
    finished: false,
    ...over,
  };
}
