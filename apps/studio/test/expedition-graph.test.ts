import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { EXPEDITION_SCHEMA_VERSION, type JsonObject } from '@explorer/shared-types';

import { expeditionApi } from '../src/expeditions/api.ts';
import {
  addBranch,
  addNode,
  addParallelStations,
  connect,
  connectProblem,
  freshId,
  issuesOf,
  missionFrom,
  moveNode,
  openDocument,
  removeEdge,
  removeNode,
  renameNode,
  roleOf,
  setEdgeLabel,
  setMissionFlag,
  startingGraph,
  toDocument,
  type GraphState,
  type MissionTypeChoice,
} from '../src/expeditions/graph.ts';

const TYPE: MissionTypeChoice = {
  key: 'bird-count',
  version: '1.0.0',
  name: 'Bird count',
  description: 'Count the birds you see.',
  defaultConfig: { species: 'Robin' },
  validationMethod: 'teacher',
  defaultScoring: { basePoints: 10, allowPartialCredit: false, maxPoints: 20 },
};

/** Everything outside the graph a valid document needs, so only the graph is on trial. */
function document(graph: JsonObject = startingGraph() as unknown as JsonObject): JsonObject {
  return {
    schemaVersion: '1.1.0',
    id: 'expedition-1',
    definitionVersion: 1,
    status: 'draft',
    metadata: {
      title: 'A walk round the museum',
      summary: 'One mission, one stop.',
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
    graph,
    rules: {
      progression: 'open',
      allowSkip: false,
      teams: { size: { min: 2, max: 4 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
      timing: { startMode: 'synchronised', endMode: 'teacher-ends' },
      hints: { enabled: false, tokensPerTeam: 0 },
      submissions: { requireReviewForAll: false, latePolicy: 'reject', allowOfflineQueue: true },
    },
    scoring: { rules: [], minimumTotal: 0, leaderboard: { visibility: 'live', tieBreaks: [] } },
  };
}

function fresh(): GraphState {
  return openDocument(document());
}

/** Start → one mission → finish, the plainest graph that passes. */
function line(): { state: GraphState; missionNode: string } {
  const added = addNode(fresh(), { kind: 'mission', type: TYPE }, 'start');
  const joined = connect(added.state, added.nodeId, 'finish');
  assert.ok(joined.ok);
  return { state: joined.state, missionNode: added.nodeId };
}

describe('opening and saving a document', () => {
  test('keeps every field the editor does not own', () => {
    const saved = toDocument(fresh());
    const original = document();
    assert.deepEqual(saved['rules'], original['rules']);
    assert.deepEqual(saved['metadata'], original['metadata']);
    assert.equal(saved['schemaVersion'], EXPEDITION_SCHEMA_VERSION);
  });

  test('reads a draft with no graph as an empty one', () => {
    const state = openDocument({ metadata: { title: 'Half built' } });
    assert.deepEqual([state.nodes, state.edges, state.missions], [[], [], []]);
    assert.deepEqual(toDocument(state)['graph'], { nodes: [], edges: [] });
  });

  test('places nodes that have no layout, in columns from the start', () => {
    const state = openDocument(
      document({
        nodes: [
          { id: 'start', kind: 'start', title: 'Start' },
          { id: 'finish', kind: 'finish', title: 'Finish' },
          { id: 'lost', kind: 'checkpoint', title: 'Lost' },
        ],
        edges: [{ id: 'e', from: 'start', to: 'finish' }],
      }),
    );
    const x = Object.fromEntries(state.nodes.map((node) => [node.id, node.layout?.x]));
    assert.ok((x['start'] ?? 0) < (x['finish'] ?? 0));
    assert.ok((x['finish'] ?? 0) < (x['lost'] ?? 0));
  });
});

describe('placing things', () => {
  test('a mission node brings its mission, started from the type', () => {
    const { state, nodeId } = addNode(fresh(), { kind: 'mission', type: TYPE });
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    assert.equal(node?.kind, 'mission');
    assert.equal(state.missions.length, 1);
    assert.deepEqual(state.missions[0], missionFrom(TYPE, 'mission-1', 'Bird count'));
    assert.equal(state.missions[0]?.verification, 'teacher');
    assert.equal(state.missions[0]?.brief, 'Count the birds you see.');
  });

  test('the type starting values are copied, not shared', () => {
    const mission = missionFrom(TYPE, 'm', 'M');
    (mission.config as { species: string }).species = 'Wren';
    assert.equal(TYPE.defaultConfig['species'], 'Robin');
  });

  test('with a node selected, what is added is joined after it', () => {
    const { state, nodeId } = addNode(fresh(), { kind: 'checkpoint' }, 'start');
    assert.deepEqual(
      state.edges.map((edge) => [edge.from, edge.to]),
      [['start', nodeId]],
    );
  });

  test('nothing is joined after a finish', () => {
    const { state } = addNode(fresh(), { kind: 'checkpoint' }, 'finish');
    assert.equal(state.edges.length, 0);
  });

  test('a new node does not land on top of another', () => {
    let state = fresh();
    state = addNode(state, { kind: 'checkpoint' }, 'start').state;
    state = addNode(state, { kind: 'checkpoint' }, 'start').state;
    const spots = state.nodes.map((node) => `${node.layout?.x},${node.layout?.y}`);
    assert.equal(new Set(spots).size, spots.length);
  });

  test('secret and boss missions carry their flags', () => {
    const secret = addNode(fresh(), { kind: 'mission', type: TYPE, secret: true });
    const boss = addNode(secret.state, { kind: 'mission', type: TYPE, boss: true });
    const byId = new Map(boss.state.nodes.map((node) => [node.id, node]));
    assert.equal(roleOf(byId.get(secret.nodeId as never)!), 'secret');
    assert.equal(roleOf(byId.get(boss.nodeId as never)!), 'boss');
    assert.equal(boss.state.missions.length, 2);
  });

  test('parallel stations: a split, the stations, and a join after all of them', () => {
    const { state, nodeId: joinId } = addParallelStations(fresh(), TYPE, 3, 'start');
    const stations = state.nodes.filter((node) => node.kind === 'mission');
    assert.equal(stations.length, 3);
    assert.equal(state.missions.length, 3);
    const split = state.edges.find((edge) => edge.from === 'start')?.to;
    for (const station of stations) {
      assert.ok(state.edges.some((edge) => edge.from === split && edge.to === station.id));
      assert.ok(state.edges.some((edge) => edge.from === station.id && edge.to === joinId));
    }
    const joined = connect(state, joinId, 'finish');
    assert.ok(joined.ok);
    assert.deepEqual(issuesOf(joined.state).graph, []);
  });

  test('a fork does not land on a node already there', () => {
    // The finish sits exactly where the first station would go.
    const state = moveNode(fresh(), 'finish', { x: 40 + 240 * 2, y: 40 - 96 });
    const { state: next } = addParallelStations(state, TYPE, 3, 'start');
    const spots = next.nodes.map((node) => node.layout!);
    for (const [index, a] of spots.entries()) {
      for (const b of spots.slice(index + 1)) {
        assert.ok(Math.abs(a.x - b.x) >= 168 || Math.abs(a.y - b.y) >= 56, `overlap at ${a.x},${a.y}`);
      }
    }
  });

  test('parallel stations are between two and eight', () => {
    const count = (n: number) =>
      addParallelStations(fresh(), TYPE, n).state.nodes.filter((node) => node.kind === 'mission').length;
    assert.equal(count(1), 2);
    assert.equal(count(20), 8);
  });

  test('a branch: two labelled paths out, and one place they meet', () => {
    const { state, nodeId: joinId } = addBranch(fresh(), TYPE, 'start');
    const labels = state.edges.map((edge) => edge.label).filter((label) => label !== undefined);
    assert.deepEqual(labels, ['Path A', 'Path B']);
    assert.equal(state.edges.filter((edge) => edge.to === joinId).length, 2);
    const joined = connect(state, joinId, 'finish');
    assert.ok(joined.ok);
    assert.deepEqual(issuesOf(joined.state).graph, []);
  });
});

describe('joining nodes', () => {
  test('refuses what the schema refuses, and says why', () => {
    const { state, missionNode } = line();
    assert.match(connectProblem(state, missionNode, missionNode) ?? '', /itself/);
    assert.match(connectProblem(state, missionNode, 'start') ?? '', /start/);
    assert.match(connectProblem(state, 'finish', missionNode) ?? '', /finish/);
    assert.match(connectProblem(state, 'start', missionNode) ?? '', /already/);
  });

  test('refuses a loop', () => {
    let state = fresh();
    const a = addNode(state, { kind: 'checkpoint' }, 'start');
    const b = addNode(a.state, { kind: 'checkpoint' }, a.nodeId);
    state = b.state;
    const result = connect(state, b.nodeId, a.nodeId);
    assert.equal(result.ok, false);
    assert.match(result.ok ? '' : result.reason, /loop/);
  });
});

describe('changing and removing', () => {
  test('moving, renaming and labelling', () => {
    const { state, missionNode } = line();
    let next = moveNode(state, missionNode, { x: 300.4, y: -5 });
    next = renameNode(next, missionNode, 'The robin');
    const edgeId = next.edges[0]!.id;
    next = setEdgeLabel(next, edgeId, 'Go on');
    const node = next.nodes.find((candidate) => candidate.id === missionNode);
    assert.deepEqual(node?.layout, { x: 300, y: 0 });
    assert.equal(node?.title, 'The robin');
    assert.equal(next.missions[0]?.title, 'Bird count', 'the mission title is not the node name');
    assert.equal(next.edges[0]?.label, 'Go on');
    assert.equal('label' in (setEdgeLabel(next, edgeId, '').edges[0] ?? {}), false);
  });

  test('turning a flag off leaves the field out', () => {
    const { state, missionNode } = line();
    const on = setMissionFlag(state, missionNode, 'boss', true);
    assert.equal(roleOf(on.nodes.find((node) => node.id === missionNode)!), 'boss');
    const off = setMissionFlag(on, missionNode, 'boss', false);
    assert.equal('boss' in off.nodes.find((node) => node.id === missionNode)!, false);
  });

  test('removing a node takes its edges and its mission with it', () => {
    const { state, missionNode } = line();
    const next = removeNode(state, missionNode);
    assert.equal(next.nodes.length, 2);
    assert.equal(next.edges.length, 0);
    assert.equal(next.missions.length, 0);
  });

  test('removing an edge', () => {
    const { state } = line();
    assert.equal(removeEdge(state, state.edges[0]!.id).edges.length, 1);
  });
});

describe('what is wrong with it', () => {
  test('a start, a mission and a finish in a line has no problems', () => {
    assert.deepEqual(issuesOf(line().state), { graph: [], elsewhere: [] });
  });

  test('an unreachable node is pointed at', () => {
    const { graph } = issuesOf(fresh());
    assert.equal(graph.length, 1);
    assert.deepEqual(graph[0]?.nodeIds, ['finish']);
  });

  test('a missing start is a graph problem', () => {
    const { graph } = issuesOf(removeNode(fresh(), 'start'));
    assert.ok(graph.some((issue) => /start node/.test(issue.message)));
  });

  test('problems outside the graph are kept apart', () => {
    const state = openDocument({ ...document(), rules: {} });
    const { elsewhere } = issuesOf(state);
    assert.ok(elsewhere.length > 0);
    assert.ok(elsewhere.every((issue) => issue.path.startsWith('rules')));
  });
});

test('ids are the first free number', () => {
  assert.equal(freshId('node', []), 'node-1');
  assert.equal(freshId('node', ['node-1', 'node-3']), 'node-2');
});

describe('the expedition calls', () => {
  function recorder() {
    const calls: { path: string; init: RequestInit | undefined }[] = [];
    const api = expeditionApi(async <T,>(path: string, init?: RequestInit) => {
      calls.push({ path, init });
      return { expeditions: [] } as T;
    });
    return { api, calls };
  }

  test('create sends a named document with a start and a finish', async () => {
    const { api, calls } = recorder();
    await api.create('Museum');
    assert.equal(calls[0]?.path, '/expeditions');
    assert.equal(calls[0]?.init?.method, 'POST');
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.definition.metadata.title, 'Museum');
    assert.deepEqual(
      body.definition.graph.nodes.map((node: { kind: string }) => node.kind),
      ['start', 'finish'],
    );
  });

  test('opens the draft when there is one, else the newest published revision', async () => {
    const { api, calls } = recorder();
    const version = { id: 'v', definitionVersion: 3, status: 'published' as const, title: 'T', updatedAt: '' };
    const base = { id: 'e1', title: 'T', summary: '', updatedAt: '', published: version };
    await api.open({ ...base, draft: { ...version, definitionVersion: 4, status: 'draft' } });
    await api.open({ ...base, draft: null });
    assert.deepEqual(
      calls.map((call) => call.path),
      ['/expeditions/e1/draft', '/expeditions/e1/versions/3'],
    );
  });

  test('saving puts the document over the draft', async () => {
    const { api, calls } = recorder();
    await api.saveDraft('e1', { metadata: { title: 'T' } });
    assert.equal(calls[0]?.path, '/expeditions/e1/draft');
    assert.equal(calls[0]?.init?.method, 'PUT');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { definition: { metadata: { title: 'T' } } });
  });
});
