import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { SCORING_RULE_TYPES, type JsonObject } from '@explorer/shared-types';

import { addNode, connect, openDocument, startingGraph, toDocument, type GraphState, type MissionTypeChoice } from '../src/expeditions/graph.ts';
import {
  RULE_FIELDS,
  addRule,
  aimAtAll,
  aimAtMission,
  issuesOfRule,
  issuesOfScoring,
  minimumTotalOf,
  moveRule,
  removeRule,
  rulesForMission,
  rulesOf,
  setMinimumTotal,
  setRuleNumber,
} from '../src/expeditions/scoring.ts';

const TYPE: MissionTypeChoice = {
  key: 'bird-count',
  version: '1.0.0',
  name: 'Bird count',
  description: 'Count the birds you see.',
  defaultConfig: {},
  validationMethod: 'teacher',
  defaultScoring: { basePoints: 10, allowPartialCredit: false },
};

const LEADERBOARD = { visibility: 'teacher-only', tieBreaks: ['earliest-finish'] };

/** Everything outside the graph a valid document needs, so only scoring is on trial. */
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
    scoring: { rules: [], minimumTotal: 0, leaderboard: LEADERBOARD },
  };
}

/** Start → mission → mission → finish, and the two mission ids. */
function two(): { state: GraphState; a: string; b: string } {
  const first = addNode(openDocument(document()), { kind: 'mission', type: TYPE }, 'start');
  const second = addNode(first.state, { kind: 'mission', type: TYPE }, first.nodeId);
  const joined = connect(second.state, second.nodeId, 'finish');
  assert.ok(joined.ok);
  const [a, b] = joined.state.missions.map((mission) => mission.id);
  return { state: joined.state, a: a!, b: b! };
}

describe('scoring rules', () => {
  test('every rule type starts with numbers the schema accepts', () => {
    const { state } = two();
    let next = state;
    for (const type of SCORING_RULE_TYPES) {
      next = addRule(next, type).state;
    }
    assert.equal(rulesOf(next).length, SCORING_RULE_TYPES.length);
    assert.deepEqual(issuesOfScoring(next), []);
  });

  test('a new rule is aimed at every mission, or at the one it was added for', () => {
    const { state, a } = two();
    const everywhere = addRule(state, 'speed-bonus');
    assert.deepEqual(rulesOf(everywhere.state)[0], {
      id: everywhere.ruleId,
      type: 'speed-bonus',
      target: { kind: 'all' },
      withinSeconds: 300,
      points: 10,
    });

    const here = addRule(state, 'hint-penalty', a);
    assert.deepEqual((rulesOf(here.state)[0] as { target: unknown }).target, {
      kind: 'missions',
      missionInstanceIds: [a],
    });
  });

  test('streak and late rules pick no missions, even when added for one', () => {
    const { state, a } = two();
    const streak = rulesOf(addRule(state, 'streak-bonus', a).state)[0]!;
    assert.equal('target' in streak, false);
    const late = rulesOf(addRule(state, 'late-penalty').state)[0]!;
    assert.equal('target' in late, false);
  });

  test('changing rules keeps the leaderboard, and only changes the scoring', () => {
    const { state } = two();
    const next = setMinimumTotal(addRule(state, 'completion-bonus').state, -50);
    const scoring = toDocument(next)['scoring'] as JsonObject;
    assert.deepEqual(scoring['leaderboard'], LEADERBOARD);
    assert.equal(minimumTotalOf(next), -50);
    assert.deepEqual(next.missions, state.missions);
    assert.deepEqual(next.nodes, state.nodes);
  });

  test('a document with no scoring is given rules and a floor on the first change', () => {
    const { scoring: _dropped, ...rest } = document();
    const state = openDocument(rest);
    assert.deepEqual(rulesOf(state), []);
    assert.equal(minimumTotalOf(state), undefined);
    const next = addRule(state, 'attempt-penalty').state;
    const scoring = toDocument(next)['scoring'] as JsonObject;
    assert.equal(scoring['minimumTotal'], 0);
    assert.equal((scoring['rules'] as unknown[]).length, 1);
  });

  test('sets a number the rule holds, and ignores one it does not', () => {
    const { state } = two();
    const added = addRule(state, 'speed-bonus');
    const faster = setRuleNumber(added.state, added.ruleId, 'withinSeconds', 120);
    assert.equal((rulesOf(faster)[0] as { withinSeconds: number }).withinSeconds, 120);
    const ignored = setRuleNumber(added.state, added.ruleId, 'pointsPerHint', 9);
    assert.deepEqual(rulesOf(ignored), rulesOf(added.state));
  });

  test('a number below what the schema allows is reported at that rule', () => {
    const { state } = two();
    const added = addRule(state, 'streak-bonus');
    const wrong = setRuleNumber(added.state, added.ruleId, 'length', 1);
    const issues = issuesOfRule(wrong, issuesOfScoring(wrong), added.ruleId);
    assert.deepEqual(issues.map((issue) => issue.path), ['length']);
  });

  test('every number field the screen offers is one the rule type has', () => {
    const { state } = two();
    for (const type of SCORING_RULE_TYPES) {
      const added = addRule(state, type);
      const rule = rulesOf(added.state)[0] as unknown as Record<string, unknown>;
      for (const field of RULE_FIELDS[type]) {
        assert.equal(typeof rule[field.name], 'number', `${type}.${field.name}`);
      }
    }
  });

  test('rules can be reordered and removed', () => {
    const { state } = two();
    const one = addRule(state, 'speed-bonus');
    const both = addRule(one.state, 'hint-penalty');
    const moved = moveRule(both.state, both.ruleId, -1);
    assert.deepEqual(rulesOf(moved).map((rule) => rule.id), [both.ruleId, one.ruleId]);
    assert.equal(moveRule(moved, both.ruleId, -1), moved);
    assert.deepEqual(rulesOf(removeRule(moved, both.ruleId)).map((rule) => rule.id), [one.ruleId]);
  });

  test('a rule can be aimed at named missions and back at every one', () => {
    const { state, a, b } = two();
    const added = addRule(state, 'completion-bonus');
    const onlyA = aimAtMission(added.state, added.ruleId, a, true);
    assert.deepEqual(rulesForMission(onlyA, a).map((rule) => rule.id), [added.ruleId]);
    assert.deepEqual(rulesForMission(onlyA, b), []);

    const both = aimAtMission(onlyA, added.ruleId, b, true);
    assert.equal(rulesForMission(both, b).length, 1);

    const none = aimAtMission(aimAtMission(both, added.ruleId, a, false), added.ruleId, b, false);
    assert.ok(issuesOfRule(none, issuesOfScoring(none), added.ruleId).some((issue) => issue.path === 'target.missionInstanceIds'));

    const all = aimAtAll(none, added.ruleId);
    assert.equal(rulesForMission(all, a).length, 1);
    assert.equal(rulesForMission(all, b).length, 1);
    assert.deepEqual(issuesOfScoring(all), []);
  });

  test('a mission is not shown rules about the whole run', () => {
    const { state, a } = two();
    const next = addRule(addRule(state, 'streak-bonus').state, 'late-penalty').state;
    assert.deepEqual(rulesForMission(next, a), []);
  });
});
