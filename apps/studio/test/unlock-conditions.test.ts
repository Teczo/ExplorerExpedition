import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  MAX_UNLOCK_CONDITION_DEPTH,
  UNLOCK_CONDITION_TYPES,
  type JsonObject,
  type UnlockCondition,
} from '@explorer/shared-types';

import {
  addNode,
  connect,
  openDocument,
  setMissionFlag,
  startingGraph,
  toDocument,
  type GraphState,
  type MissionTypeChoice,
} from '../src/expeditions/graph.ts';
import {
  addRoute,
  addToGroup,
  canNestAt,
  changeConditionType,
  describeCondition,
  edgesWaitingOn,
  issuesOfEdge,
  issuesOfRoutes,
  missionsNamed,
  newCondition,
  removeFromGroup,
  removeRoute,
  renameRoute,
  replaceInside,
  routesOf,
  setConditionMission,
  setConditionNumber,
  setEdgeCondition,
  setEdgeRoutes,
  toggleConditionMission,
  toggleEdgeRoute,
  waysInto,
} from '../src/expeditions/unlock.ts';

const TYPE: MissionTypeChoice = {
  key: 'bird-count',
  version: '1.0.0',
  name: 'Bird count',
  description: 'Count the birds you see.',
  defaultConfig: {},
  validationMethod: 'teacher',
  defaultScoring: { basePoints: 10, allowPartialCredit: false },
};

/** Everything outside the graph a valid document needs, so only the graph is on trial. */
function document(): JsonObject {
  return {
    schemaVersion: '1.1.0',
    id: 'expedition-1',
    definitionVersion: 1,
    status: 'draft',
    metadata: {
      title: 'A walk round the museum',
      summary: 'Two missions.',
      locale: 'en-GB',
      ageRange: { min: 9, max: 11 },
      expectedDurationMinutes: { min: 30, max: 60 },
      subjects: [],
      tags: [],
      setting: 'indoor',
      authoring: {
        organisationId: 'org-1',
        createdBy: 'user-1',
        createdAt: '2026-05-12T10:00:00.000Z',
        updatedBy: 'user-1',
        updatedAt: '2026-05-12T10:00:00.000Z',
        source: 'studio',
      },
    },
    missions: [],
    graph: startingGraph() as unknown as JsonObject,
    rules: {
      progression: 'open',
      allowSkip: false,
      teams: { size: { min: 2, max: 4 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
      timing: { startMode: 'synchronised', endMode: 'teacher-ends' },
      hints: { enabled: false, tokensPerTeam: 0 },
      submissions: { requireReviewForAll: false, latePolicy: 'reject', allowOfflineQueue: true },
    },
    scoring: { rules: [], minimumTotal: 0, leaderboard: { visibility: 'teacher-only', tieBreaks: ['earliest-finish'] } },
  };
}

/** Start → A → B → finish. The two mission ids, their nodes, and the edge from A to B. */
function two() {
  const first = addNode(openDocument(document()), { kind: 'mission', type: TYPE }, 'start');
  const second = addNode(first.state, { kind: 'mission', type: TYPE }, first.nodeId);
  const joined = connect(second.state, second.nodeId, 'finish');
  assert.ok(joined.ok);
  const state = joined.state;
  const [a, b] = state.missions.map((mission) => mission.id as string);
  const edge = state.edges.find((candidate) => candidate.from === first.nodeId && candidate.to === second.nodeId);
  assert.ok(edge);
  return { state, a: a!, b: b!, nodeA: first.nodeId, nodeB: second.nodeId, edgeId: edge.id as string };
}

function edgeOf(state: GraphState, edgeId: string) {
  const edge = state.edges.find((candidate) => candidate.id === edgeId);
  assert.ok(edge);
  return edge;
}

describe('unlock conditions', () => {
  test('every condition type starts with values the schema accepts', () => {
    const { state, a, edgeId } = two();
    for (const type of UNLOCK_CONDITION_TYPES) {
      const next = setEdgeCondition(state, edgeId, newCondition(type, a));
      assert.deepEqual(issuesOfEdge(next, edgeId), [], type);
    }
  });

  test('no condition, or always, leaves the field out', () => {
    const { state, a, edgeId } = two();
    const gated = setEdgeCondition(state, edgeId, newCondition('mission-completed', a));
    assert.deepEqual(edgeOf(gated, edgeId).condition, { type: 'mission-completed', missionInstanceId: a });
    assert.equal('condition' in edgeOf(setEdgeCondition(gated, edgeId, undefined), edgeId), false);
    assert.equal('condition' in edgeOf(setEdgeCondition(gated, edgeId, { type: 'always' }), edgeId), false);
  });

  test('changing the type keeps the mission, and wraps a test in a group', () => {
    const { a, b } = two();
    const finished = newCondition('mission-completed', a);
    const score = changeConditionType(finished, 'mission-score-at-least', b);
    assert.deepEqual(score, { type: 'mission-score-at-least', missionInstanceId: a, points: 10 });

    const all = changeConditionType(score, 'all-of', b);
    assert.deepEqual(all, { type: 'all-of', conditions: [score] });

    const any = changeConditionType(all, 'any-of', b);
    assert.deepEqual(any, { type: 'any-of', conditions: [score] });

    const not = changeConditionType(finished, 'not', b);
    assert.deepEqual(not, { type: 'not', condition: finished });

    // Back from a group to the type of its first test gives that test back.
    assert.deepEqual(changeConditionType(all, 'mission-score-at-least', b), score);
    // To any other test, the mission it named carries over.
    assert.deepEqual(changeConditionType(all, 'mission-completed', b), { type: 'mission-completed', missionInstanceId: a });
  });

  test('numbers and missions are set only where the type holds them', () => {
    const { a, b } = two();
    const score = newCondition('mission-score-at-least', a);
    assert.equal((setConditionNumber(score, 'points', 25) as { points: number }).points, 25);
    assert.equal(setConditionNumber(score, 'seconds', 25), score);
    assert.deepEqual(setConditionMission(score, b), { ...score, missionInstanceId: b });

    const time = newCondition('total-score-at-least', a);
    assert.equal(setConditionMission(time, b), time);
  });

  test('"some of these" ticks missions in and out, and the check catches a count too big', () => {
    const { state, a, b, edgeId } = two();
    let some = newCondition('missions-completed-at-least', a);
    some = toggleConditionMission(some, b, true);
    some = setConditionNumber(some, 'count', 2);
    assert.deepEqual(some, { type: 'missions-completed-at-least', count: 2, missionInstanceIds: [a, b] });
    assert.deepEqual(issuesOfEdge(setEdgeCondition(state, edgeId, some), edgeId), []);

    const fewer = toggleConditionMission(some, a, false);
    const issues = issuesOfEdge(setEdgeCondition(state, edgeId, fewer), edgeId);
    assert.deepEqual(issues.map((issue) => issue.path), ['condition.count']);
  });

  test('groups take tests in, change them and give them up', () => {
    const { a, b } = two();
    let group = newCondition('all-of', a);
    group = addToGroup(group, newCondition('mission-completed', a));
    group = addToGroup(group, newCondition('total-score-at-least', a));
    group = replaceInside(group, 0, newCondition('mission-completed', b));
    assert.deepEqual(group, {
      type: 'all-of',
      conditions: [
        { type: 'mission-completed', missionInstanceId: b },
        { type: 'total-score-at-least', points: 50 },
      ],
    });
    assert.deepEqual(removeFromGroup(group, 0), { type: 'all-of', conditions: [{ type: 'total-score-at-least', points: 50 }] });

    const not = replaceInside(newCondition('not', a), 0, { type: 'elapsed-time-at-least', seconds: 60 });
    assert.deepEqual(not, { type: 'not', condition: { type: 'elapsed-time-at-least', seconds: 60 } });
  });

  test('a problem deep in a group is reported at its own path', () => {
    const { state, a, edgeId } = two();
    const group = addToGroup(newCondition('any-of', a), setConditionNumber(newCondition('elapsed-time-at-least', a), 'seconds', 0));
    const issues = issuesOfEdge(setEdgeCondition(state, edgeId, group), edgeId);
    assert.deepEqual(issues.map((issue) => issue.path), ['condition.conditions[0].seconds']);
  });

  test('a condition naming a deleted mission is reported', () => {
    const { state, edgeId } = two();
    const issues = issuesOfEdge(setEdgeCondition(state, edgeId, newCondition('mission-completed', 'mission-99')), edgeId);
    assert.deepEqual(issues.map((issue) => issue.path), ['condition.missionInstanceId']);
  });

  test('groups may nest only as deep as the schema allows', () => {
    assert.equal(canNestAt(1), true);
    assert.equal(canNestAt(MAX_UNLOCK_CONDITION_DEPTH - 1), true);
    assert.equal(canNestAt(MAX_UNLOCK_CONDITION_DEPTH), false);
  });

  test('reads a condition in plain words, and names every mission in it once', () => {
    const { state, a, b } = two();
    const names = new Map(state.missions.map((mission) => [mission.id as string, mission.title]));
    const condition: UnlockCondition = {
      type: 'all-of',
      conditions: [
        { type: 'mission-completed', missionInstanceId: a as never },
        {
          type: 'any-of',
          conditions: [
            { type: 'total-score-at-least', points: 50 },
            { type: 'elapsed-time-at-least', seconds: 1200 },
          ],
        },
        { type: 'not', condition: { type: 'mission-score-at-least', missionInstanceId: b as never, points: 5 } },
        { type: 'missions-completed-at-least', count: 1, missionInstanceIds: [a as never, b as never] },
      ],
    };
    const A = names.get(a);
    const B = names.get(b);
    assert.equal(
      describeCondition(condition, (id) => names.get(id) ?? id),
      `${A} finished and (total ≥ 50 pts or after 20 min) and not ${B} ≥ 5 pts and 1 of 2 finished`,
    );
    assert.deepEqual(missionsNamed(condition), [a, b]);
    assert.equal(describeCondition({ type: 'any-of', conditions: [] }, String), 'never');
  });
});

describe('routes', () => {
  test('adds routes with ids made from their names, never clashing', () => {
    const { state } = two();
    const river = addRoute(state, 'The River');
    const again = addRoute(river.state, 'the river');
    assert.equal(river.routeId, 'the-river');
    assert.notEqual(again.routeId, river.routeId);
    assert.deepEqual(routesOf(again.state).map((route) => route.name), ['The River', 'the river']);
    assert.deepEqual(issuesOfRoutes(again.state), []);
  });

  test('changing routes keeps every other rule', () => {
    const { state } = two();
    const before = toDocument(state)['rules'] as JsonObject;
    const after = toDocument(renameRoute(addRoute(state, 'Hill').state, 'hill', 'Up the hill'))['rules'] as JsonObject;
    const { routes, ...rest } = after;
    assert.deepEqual(rest, before);
    assert.deepEqual(routes, [{ id: 'hill', name: 'Up the hill' }]);
  });

  test('an edge can be for chosen routes, and for every team again', () => {
    const { state, edgeId } = two();
    const withRoutes = addRoute(addRoute(state, 'River').state, 'Hill').state;
    const river = toggleEdgeRoute(withRoutes, edgeId, 'river', true);
    assert.deepEqual(edgeOf(river, edgeId).audience, { kind: 'routes', routeIds: ['river'] });
    assert.deepEqual(issuesOfEdge(river, edgeId), []);

    const none = toggleEdgeRoute(river, edgeId, 'river', false);
    assert.deepEqual(issuesOfEdge(none, edgeId).map((issue) => issue.path), ['audience.routeIds']);

    assert.equal('audience' in edgeOf(setEdgeRoutes(none, edgeId, null), edgeId), false);
  });

  test('removing a route takes it off every edge, and the last one leaves the field out', () => {
    const { state, edgeId } = two();
    const withRoute = addRoute(state, 'River').state;
    const onEdge = toggleEdgeRoute(withRoute, edgeId, 'river', true);
    const removed = removeRoute(onEdge, 'river');
    assert.deepEqual(routesOf(removed), []);
    assert.equal('routes' in (toDocument(removed)['rules'] as JsonObject), false);
    // The edge is not quietly opened to every team; the check says it is for nobody.
    assert.deepEqual(edgeOf(removed, edgeId).audience, { kind: 'routes', routeIds: [] });
    assert.deepEqual(issuesOfEdge(removed, edgeId).map((issue) => issue.path), ['audience.routeIds']);
  });
});

describe('dependencies', () => {
  test('a stop waits on the mission before it, and on the missions its conditions name', () => {
    const { state, a, b, nodeA, nodeB, edgeId } = two();
    const [way] = waysInto(state, nodeB);
    assert.equal(way?.clearFirst, a);
    assert.deepEqual(way?.named, []);

    const gated = setEdgeCondition(state, edgeId, newCondition('mission-score-at-least', a));
    assert.deepEqual(waysInto(gated, nodeB)[0]?.named, [a]);
    assert.deepEqual(edgesWaitingOn(gated, a).map((edge) => edge.id), [edgeId]);
    assert.deepEqual(edgesWaitingOn(gated, b), []);

    assert.equal(waysInto(state, nodeA)[0]?.clearFirst, undefined);
  });

  test('an optional mission never stands in front of the next stop', () => {
    const { state, nodeA, nodeB } = two();
    const optional = setMissionFlag(state, nodeA, 'optional', true);
    const node = optional.nodes.find((candidate) => candidate.id === nodeA);
    assert.equal(node?.kind === 'mission' && node.optional, true);
    assert.equal(waysInto(optional, nodeB)[0]?.clearFirst, undefined);

    const back = setMissionFlag(optional, nodeA, 'optional', false);
    assert.equal('optional' in (back.nodes.find((candidate) => candidate.id === nodeA) ?? {}), false);
  });
});
