/**
 * Turning two snapshots into the lines between them (EXPD-014).
 *
 * The progression engine (EXPD-013) answers "where does this team stand", and
 * it answers it from scratch every time. That is the right shape for a
 * mission board and the wrong one for a record: nothing about a snapshot says
 * when the lock came off a mission, and a snapshot worked out again next week
 * is worked out against next week's document.
 *
 * So whoever moves a team compares the snapshot before with the snapshot
 * after, and what changed between them is written down:
 *
 * ```ts
 * const before = evaluateProgression({ policy, situation: was });
 * const after = evaluateProgression({ policy, situation: now });
 * stream = appendProgressionEvents(
 *   stream,
 *   progressionEventsBetween(before, after, at),
 * );
 * ```
 *
 * **Only doors that opened are written down.** Progression goes one way: a
 * stop stays reached, a cleared stop stays cleared, and a revealed mission
 * stays revealed. A mission can go back to locked in `strict` mode when it is
 * somebody else's turn, and that is not written down, because the record is
 * of what a team was let do and letting it lapse is not something anybody
 * disputes. A pause or a manual override (EXPD-058) that really does take
 * something away is a line a teacher causes, and EXPD-058 is what writes it.
 *
 * **The order inside one call is the order the doors opened in.** Stops are
 * reached before they clear, a mission is shown before its lock comes off,
 * and finishing the expedition is the last thing that can happen — so a
 * reader who knows nothing about the graph can still read the stream as a
 * story. Within each of those, the document's own order decides, which is the
 * order the snapshot lists them in.
 */

import type {
  IsoTimestamp,
  MissionInstanceId,
  NodeId,
  ProgressionEvent,
  ProgressionMission,
  ProgressionNode,
  ProgressionSnapshot,
} from '@explorer/shared-types';

/** A snapshot of a team that has done nothing, for the first comparison. */
const NOTHING_YET: ProgressionSnapshot = {
  nodes: [],
  missions: [],
  unlockedMissionIds: [],
  visibleMissionIds: [],
  reachedFinishNodeIds: [],
  finished: false,
};

/** Indexes a snapshot's stops by id, so a comparison is not quadratic. */
function nodesById(
  snapshot: ProgressionSnapshot,
): ReadonlyMap<NodeId, ProgressionNode> {
  return new Map(snapshot.nodes.map((node) => [node.nodeId, node]));
}

/** Indexes a snapshot's missions by id, for the same reason. */
function missionsById(
  snapshot: ProgressionSnapshot,
): ReadonlyMap<MissionInstanceId, ProgressionMission> {
  return new Map(
    snapshot.missions.map((mission) => [mission.missionInstanceId, mission]),
  );
}

/**
 * Every door that opened between two snapshots of one team.
 *
 * `before` is left out for a team's first snapshot, which reads as a team
 * that had got nowhere — so the start node being reached is a line in the
 * record rather than something the record assumes.
 */
export function progressionEventsBetween(
  before: ProgressionSnapshot | undefined,
  after: ProgressionSnapshot,
  at: IsoTimestamp,
): readonly ProgressionEvent[] {
  const was = before ?? NOTHING_YET;
  const wasNode = nodesById(was);
  const wasMission = missionsById(was);
  const events: ProgressionEvent[] = [];

  for (const node of after.nodes) {
    if (node.reached && wasNode.get(node.nodeId)?.reached !== true) {
      events.push({ reason: 'node-reached', at, nodeId: node.nodeId });
    }
  }

  for (const node of after.nodes) {
    if (node.cleared && wasNode.get(node.nodeId)?.cleared !== true) {
      events.push({ reason: 'node-cleared', at, nodeId: node.nodeId });
    }
  }

  for (const mission of after.missions) {
    const previous = wasMission.get(mission.missionInstanceId);
    if (mission.visible && previous?.visible !== true) {
      events.push({
        reason: 'mission-revealed',
        at,
        nodeId: mission.nodeId,
        missionInstanceId: mission.missionInstanceId,
      });
    }
  }

  for (const mission of after.missions) {
    const previous = wasMission.get(mission.missionInstanceId);
    if (mission.unlocked && previous?.unlocked !== true) {
      events.push({
        reason: 'mission-unlocked',
        at,
        nodeId: mission.nodeId,
        missionInstanceId: mission.missionInstanceId,
      });
    }
  }

  if (after.finished && !was.finished) {
    const reached = after.reachedFinishNodeIds.at(0);
    events.push({
      reason: 'expedition-finished',
      at,
      ...(reached === undefined ? {} : { nodeId: reached }),
    });
  }

  return events;
}
