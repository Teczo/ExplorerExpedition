import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import type { ConfigSchema, JsonObject, MissionInstance } from '@explorer/shared-types';

import { fieldsFromSchema } from '../src/mission-types/fields.ts';
import { addNode, connect, openDocument, startingGraph, toDocument, type GraphState, type MissionTypeChoice } from '../src/expeditions/graph.ts';
import {
  addHint,
  hintsInOrder,
  issuesAt,
  issuesOfMission,
  moveHint,
  readConfigJson,
  readNumber,
  removeHint,
  setAttempts,
  setConfig,
  setConfigValue,
  setMissionText,
  setScoring,
  setTimeLimit,
  setVerification,
  typeOf,
  updateHint,
  type MissionTypeRef,
} from '../src/expeditions/properties.ts';

const SCHEMA: ConfigSchema = {
  type: 'object',
  properties: {
    species: { type: 'string', title: 'Species', minLength: 1 },
    count: { type: 'integer', minimum: 0 },
  },
  required: ['species'],
  additionalProperties: false,
};

const TYPE: MissionTypeChoice & MissionTypeRef = {
  key: 'bird-count',
  version: '1.0.0',
  name: 'Bird count',
  description: 'Count the birds you see.',
  defaultConfig: { species: 'Robin' },
  configSchema: SCHEMA,
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

/** Start → one mission → finish, and the id of the mission. */
function line(): { state: GraphState; missionId: string } {
  const added = addNode(openDocument(document()), { kind: 'mission', type: TYPE }, 'start');
  const joined = connect(added.state, added.nodeId, 'finish');
  assert.ok(joined.ok);
  return { state: joined.state, missionId: joined.state.missions[0]!.id };
}

function only(state: GraphState): MissionInstance {
  assert.equal(state.missions.length, 1);
  return state.missions[0]!;
}

describe('editing a mission', () => {
  test('a mission as placed has no problems', () => {
    const { state, missionId } = line();
    assert.deepEqual(issuesOfMission(state, missionId, TYPE), []);
  });

  test('changes only the mission it is given', () => {
    const { state, missionId } = line();
    const two = addNode(state, { kind: 'mission', type: TYPE }).state;
    const next = setMissionText(two, missionId, 'title', 'Count the robins');
    assert.equal(next.missions[0]!.title, 'Count the robins');
    assert.deepEqual(next.missions[1], two.missions[1]);
    assert.deepEqual(next.nodes, two.nodes);
  });

  test('empty instructions are left out; an empty brief is kept and reported', () => {
    const { state, missionId } = line();
    const withText = setMissionText(state, missionId, 'instructions', 'Stand by the pond.');
    assert.equal(only(withText).instructions, 'Stand by the pond.');
    assert.equal('instructions' in only(setMissionText(withText, missionId, 'instructions', '')), false);

    const noBrief = setMissionText(state, missionId, 'brief', '');
    assert.equal(only(noBrief).brief, '');
    assert.ok(issuesAt(issuesOfMission(noBrief, missionId, TYPE), 'brief').length > 0);
  });

  test('verification is written as chosen', () => {
    const { state, missionId } = line();
    assert.equal(only(setVerification(state, missionId, 'automatic')).verification, 'automatic');
  });

  test('scoring: no cap leaves maxPoints out, and a cap below the points is reported', () => {
    const { state, missionId } = line();
    const uncapped = setScoring(state, missionId, { basePoints: 5, allowPartialCredit: true, maxPoints: undefined });
    assert.deepEqual(only(uncapped).scoring, { basePoints: 5, allowPartialCredit: true });

    const wrong = setScoring(state, missionId, { basePoints: 30, allowPartialCredit: false, maxPoints: 20 });
    const issues = issuesAt(issuesOfMission(wrong, missionId, TYPE), 'scoring');
    assert.deepEqual(issues.map((issue) => issue.path), ['scoring.maxPoints']);
  });

  test('attempts and time limit', () => {
    const { state, missionId } = line();
    const limited = setAttempts(state, missionId, { maxAttempts: 3, cooldownSeconds: 30 });
    assert.deepEqual(only(limited).attempts, { maxAttempts: 3, cooldownSeconds: 30 });
    const open = setAttempts(limited, missionId, { maxAttempts: null, cooldownSeconds: undefined });
    assert.deepEqual(only(open).attempts, { maxAttempts: null });

    const timed = setTimeLimit(state, missionId, 300);
    assert.equal(only(timed).timeLimitSeconds, 300);
    assert.equal('timeLimitSeconds' in only(setTimeLimit(timed, missionId, undefined)), false);
  });

  test('the saved document carries the edits', () => {
    const { state, missionId } = line();
    const next = setMissionText(state, missionId, 'brief', 'Count every robin by the pond.');
    const saved = toDocument(next)['missions'] as unknown as MissionInstance[];
    assert.equal(saved[0]!.brief, 'Count every robin by the pond.');
  });
});

describe('hints', () => {
  test('are added in order, with fresh ids, free and empty', () => {
    const { state, missionId } = line();
    const two = addHint(addHint(state, missionId), missionId);
    assert.deepEqual(
      only(two).hints.map((hint) => [hint.id, hint.order, hint.tokenCost, hint.text]),
      [
        ['hint-1', 0, 0, ''],
        ['hint-2', 1, 0, ''],
      ],
    );
    // An empty hint is a problem the panel shows next to it.
    assert.ok(issuesAt(issuesOfMission(two, missionId, TYPE), 'hints').length > 0);
  });

  test('are changed, moved and removed', () => {
    const { state, missionId } = line();
    let next = addHint(addHint(state, missionId), missionId);
    next = updateHint(next, missionId, 'hint-2', { text: 'Look up.', tokenCost: 2 });
    next = moveHint(next, missionId, 'hint-2', -1);
    assert.deepEqual(hintsInOrder(only(next)).map((hint) => hint.id), ['hint-2', 'hint-1']);
    // The first hint cannot move further up.
    assert.deepEqual(moveHint(next, missionId, 'hint-2', -1).missions, next.missions);

    next = removeHint(next, missionId, 'hint-1');
    assert.deepEqual(only(next).hints, [{ id: 'hint-2', text: 'Look up.', order: 0, tokenCost: 2 }]);
    // The next hint added goes after the last one, whatever was removed.
    assert.deepEqual(only(addHint(next, missionId)).hints.map((hint) => [hint.id, hint.order]), [
      ['hint-2', 0],
      ['hint-1', 1],
    ]);
  });
});

describe("the type's own settings", () => {
  test('are set and taken out one at a time', () => {
    const { state, missionId } = line();
    const counted = setConfigValue(state, missionId, 'count', 4);
    assert.deepEqual(only(counted).config, { species: 'Robin', count: 4 });
    assert.deepEqual(only(setConfigValue(counted, missionId, 'count', undefined)).config, { species: 'Robin' });
  });

  test("are checked against the type's schema, which the document check cannot do", () => {
    const { state, missionId } = line();
    const wrong = setConfigValue(setConfigValue(state, missionId, 'species', undefined), missionId, 'count', -1);
    const issues = issuesAt(issuesOfMission(wrong, missionId, TYPE), 'config');
    assert.ok(issues.length >= 2);
    assert.ok(issues.every((issue) => issue.path.startsWith('config')));
    assert.ok(issuesAt(issues, 'config.count').length > 0);
  });

  test('can be replaced whole, for a schema the panel cannot draw as fields', () => {
    const { state, missionId } = line();
    assert.deepEqual(only(setConfig(state, missionId, { species: 'Wren' })).config, { species: 'Wren' });
  });

  test('a mission whose type is not available says so', () => {
    const { state, missionId } = line();
    const issues = issuesOfMission(state, missionId, undefined);
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.path, '');
  });

  test('the type is found by key and pinned version', () => {
    const mission = only(line().state);
    assert.equal(typeOf([TYPE], mission), TYPE);
    assert.equal(typeOf([{ ...TYPE, version: '2.0.0' }], mission), undefined);
  });

  test("the type's schema draws as fields", () => {
    const fields = fieldsFromSchema(SCHEMA);
    assert.deepEqual(fields?.map((field) => [field.name, field.kind, field.required]), [
      ['species', 'text', true],
      ['count', 'whole-number', false],
    ]);
  });
});

describe('reading what was typed', () => {
  test('numbers', () => {
    assert.deepEqual(readNumber('12', { whole: true, min: 0 }), { ok: true, value: 12 });
    assert.deepEqual(readNumber(' ', { optional: true }), { ok: true, value: undefined });
    assert.equal(readNumber('', {}).ok, false);
    assert.equal(readNumber('1.5', { whole: true }).ok, false);
    assert.equal(readNumber('abc').ok, false);
    assert.equal(readNumber('0', { min: 1 }).ok, false);
  });

  test('a config as JSON', () => {
    assert.deepEqual(readConfigJson('{"a": 1}'), { ok: true, value: { a: 1 } });
    assert.equal(readConfigJson('[1]').ok, false);
    assert.equal(readConfigJson('{').ok, false);
  });
});
