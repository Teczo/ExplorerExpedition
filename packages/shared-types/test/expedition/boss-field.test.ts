/**
 * The field the graph editor added to the schema (EXPD-026).
 *
 * `boss` on a mission stop. What is tested here is that a document using it
 * passes, that a document misusing it is turned away with the path to the
 * field, and that a document written before it existed still reads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  EXPEDITION_SCHEMA_VERSION,
  isReadableSchemaVersion,
  validateExpeditionDefinition,
  type ValidationIssue,
} from '../../src/index.ts';

/** A document with one mission on one stop, and nothing else in it. */
function definition(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.2.0',
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
    missions: [
      {
        id: 'alpha',
        missionTypeId: 'code-match',
        missionTypeVersion: '1.0.0',
        title: 'Find the code',
        brief: 'Look for it.',
        config: {},
        scoring: { basePoints: 100, allowPartialCredit: false },
        attempts: { maxAttempts: null },
        verification: 'automatic',
        hints: [],
        media: [],
      },
    ],
    graph: {
      nodes: [
        { id: 'start', title: 'Start', kind: 'start' },
        { id: 'node-alpha', title: 'The code', kind: 'mission', missionInstanceId: 'alpha' },
        { id: 'finish', title: 'Finish', kind: 'finish' },
      ],
      edges: [
        { id: 'e1', from: 'start', to: 'node-alpha' },
        { id: 'e2', from: 'node-alpha', to: 'finish' },
      ],
    },
    rules: {
      progression: 'strict',
      allowSkip: false,
      teams: { size: { min: 2, max: 4 }, maxTeams: null, roles: [], requireFullTeamToStart: false },
      timing: { startMode: 'synchronised', endMode: 'teacher-ends' },
      hints: { enabled: false, tokensPerTeam: 0 },
      submissions: {
        requireReviewForAll: false,
        latePolicy: 'reject',
        allowOfflineQueue: true,
      },
    },
    scoring: {
      rules: [],
      minimumTotal: 0,
      leaderboard: { visibility: 'live', tieBreaks: [] },
    },
    ...over,
  };
}

/** The problems a document was turned away for. */
function issuesOf(document: Record<string, unknown>): ValidationIssue[] {
  const result = validateExpeditionDefinition(document);
  return result.valid ? [] : result.issues;
}

describe('a boss mission', () => {
  it('came in at 1.2.0, which is still read', () => {
    assert.ok(isReadableSchemaVersion('1.2.0'));
    assert.notEqual(EXPEDITION_SCHEMA_VERSION, '1.1.0');
  });

  it('takes boss on a mission stop, beside secret and optional', () => {
    const document = definition();
    const graph = document['graph'] as { nodes: Record<string, unknown>[] };
    graph.nodes[1] = { ...graph.nodes[1], boss: true, secret: true };

    assert.deepEqual(issuesOf(document), []);
  });

  it('wants it to be true or false', () => {
    const document = definition();
    const graph = document['graph'] as { nodes: Record<string, unknown>[] };
    graph.nodes[1] = { ...graph.nodes[1], boss: 'yes' };

    assert.deepEqual(issuesOf(document), [
      {
        path: 'graph.nodes[1].boss',
        code: 'wrong-type',
        message: 'This has to be true or false.',
      },
    ]);
  });

  it('still reads a document written before it existed', () => {
    assert.deepEqual(issuesOf(definition({ schemaVersion: '1.1.0' })), []);
  });
});
