/**
 * Reading the limits out of the revision a run is pinned to (EXPD-018).
 *
 * `expedition_version.definition` is `jsonb`, so what comes back is JSON and
 * not a typed object, and a revision written against an older schema version
 * may be short of a field. Every test here is about the same decision: a gap
 * in a document falls back to a wide default rather than throwing, because
 * refusing to let a class join over a missing optional field would be the
 * worse failure by a distance.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_TEAM_RULES,
  participantCapacityOf,
  teamRulesOf,
} from '../../src/participation/team-rules.ts';
import { definitionWith } from './support.ts';

describe('reading rules.teams', () => {
  test('takes what the document says', () => {
    const rules = teamRulesOf(
      definitionWith({
        size: { min: 3, max: 5 },
        maxTeams: 8,
        roles: ['navigator'],
        requireFullTeamToStart: true,
      }),
    );

    assert.deepEqual(rules, {
      size: { min: 3, max: 5 },
      maxTeams: 8,
      roles: ['navigator'],
      requireFullTeamToStart: true,
    });
  });

  test('falls back when there is no document at all', () => {
    assert.deepEqual(teamRulesOf(null), DEFAULT_TEAM_RULES);
  });

  test('falls back when the document has no rules in it', () => {
    assert.deepEqual(teamRulesOf({ schemaVersion: '1.0.0' }), DEFAULT_TEAM_RULES);
  });

  test('falls back on a range whose minimum is above its maximum', () => {
    const rules = teamRulesOf({ rules: { teams: { size: { min: 9, max: 2 } } } });

    assert.deepEqual(rules.size, DEFAULT_TEAM_RULES.size);
  });

  test('falls back on a size that is not a whole number', () => {
    const rules = teamRulesOf({ rules: { teams: { size: { min: 1, max: 2.5 } } } });

    assert.deepEqual(rules.size, DEFAULT_TEAM_RULES.size);
  });

  test('reads no cap on teams as no cap, not as zero', () => {
    assert.equal(teamRulesOf({ rules: { teams: { maxTeams: null } } }).maxTeams, null);
    assert.equal(teamRulesOf({ rules: { teams: {} } }).maxTeams, null);
    assert.equal(teamRulesOf({ rules: { teams: { maxTeams: 0 } } }).maxTeams, null);
  });

  test('keeps each role once, and drops anything that is not a name', () => {
    const rules = teamRulesOf({
      rules: { teams: { roles: ['navigator', 'navigator', '  ', 7, null] } },
    });

    assert.deepEqual(rules.roles, ['navigator']);
  });

  test('reads a missing requireFullTeamToStart as false', () => {
    assert.equal(teamRulesOf({ rules: { teams: {} } }).requireFullTeamToStart, false);
  });
});

describe('how many students a run can hold', () => {
  test('is as many teams as it allows, each as full as a team may be', () => {
    assert.equal(
      participantCapacityOf({
        size: { min: 2, max: 4 },
        maxTeams: 6,
        roles: [],
        requireFullTeamToStart: false,
      }),
      24,
    );
  });

  test('is nothing this ticket knows when the expedition caps no teams', () => {
    assert.equal(participantCapacityOf(DEFAULT_TEAM_RULES), null);
  });
});
