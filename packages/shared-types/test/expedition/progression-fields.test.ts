/**
 * The three fields progression added to the schema (EXPD-013).
 *
 * `optional` and `secret` on a mission stop, `audience` on an edge, and the
 * routes an audience names on the expedition's rules. What is tested here is
 * that a document using them passes, that a document misusing them is turned
 * away with the path to the field that is wrong, and that a document written
 * before any of them existed still reads as a valid one.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  validateExpeditionDefinition,
  type ValidationIssue,
} from '../../src/index.ts';

/** A document with one mission on one stop, and nothing else in it. */
function definition(over: Record<string, unknown> = {}): Record<string, unknown> {
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

describe('the plainest document there is', () => {
  it('passes', () => {
    assert.deepEqual(issuesOf(definition()), []);
  });

  it('still passes when it was written before any of this existed', () => {
    assert.deepEqual(issuesOf(definition({ schemaVersion: '1.0.0' })), []);
  });
});

describe('optional and secret stops', () => {
  it('takes both on a mission stop', () => {
    const document = definition();
    const graph = document['graph'] as { nodes: Record<string, unknown>[] };
    graph.nodes[1] = { ...graph.nodes[1], optional: true, secret: true };

    assert.deepEqual(issuesOf(document), []);
  });

  it('wants them to be true or false', () => {
    const document = definition();
    const graph = document['graph'] as { nodes: Record<string, unknown>[] };
    graph.nodes[1] = { ...graph.nodes[1], optional: 'yes' };

    assert.deepEqual(issuesOf(document), [
      {
        path: 'graph.nodes[1].optional',
        code: 'wrong-type',
        message: 'This has to be true or false.',
      },
    ]);
  });
});

describe('an edge for some teams rather than all of them', () => {
  /** The same document, with one route declared and the edge named for it. */
  function withRoute(audience: unknown, routes: unknown = [{ id: 'walkers', name: 'Walkers' }]) {
    const document = definition();
    const graph = document['graph'] as { edges: Record<string, unknown>[] };
    graph.edges[0] = { ...graph.edges[0], audience };
    const rules = document['rules'] as Record<string, unknown>;
    rules['routes'] = routes;
    return document;
  }

  it('takes an audience naming a route the expedition declares', () => {
    assert.deepEqual(issuesOf(withRoute({ kind: 'routes', routeIds: ['walkers'] })), []);
  });

  it('takes an audience that is for everybody', () => {
    assert.deepEqual(issuesOf(withRoute({ kind: 'all' })), []);
  });

  it('turns away a route the expedition does not have', () => {
    assert.deepEqual(issuesOf(withRoute({ kind: 'routes', routeIds: ['cyclists'] })), [
      {
        path: 'graph.edges[0].audience.routeIds[0]',
        code: 'unknown-reference',
        message: 'No route in this expedition has the id "cyclists".',
      },
    ]);
  });

  it('turns away an edge for nobody', () => {
    assert.deepEqual(issuesOf(withRoute({ kind: 'routes', routeIds: [] })), [
      {
        path: 'graph.edges[0].audience.routeIds',
        code: 'out-of-range',
        message: 'An edge for no route is an edge no team can take. Delete it instead.',
      },
    ]);
  });

  it('turns away a route named twice on one edge', () => {
    const issues = issuesOf(withRoute({ kind: 'routes', routeIds: ['walkers', 'walkers'] }));

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, 'inconsistent');
    assert.equal(issues[0]?.path, 'graph.edges[0].audience.routeIds[1]');
  });

  it('turns away an audience of a kind the schema does not have', () => {
    const issues = issuesOf(withRoute({ kind: 'everyone-but-them' }));

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, 'not-allowed-value');
    assert.equal(issues[0]?.path, 'graph.edges[0].audience.kind');
  });
});

describe('the routes an expedition declares', () => {
  /** The same document, with whatever the test wants to say about routes. */
  function withRoutes(routes: unknown): Record<string, unknown> {
    const document = definition();
    (document['rules'] as Record<string, unknown>)['routes'] = routes;
    return document;
  }

  it('takes a list of them', () => {
    assert.deepEqual(
      issuesOf(
        withRoutes([
          { id: 'walkers', name: 'The walkers' },
          { id: 'cyclists', name: 'The cyclists', description: 'Over the hill.' },
        ]),
      ),
      [],
    );
  });

  it('takes an expedition with none', () => {
    assert.deepEqual(issuesOf(withRoutes([])), []);
  });

  it('wants every route to have a name', () => {
    const issues = issuesOf(withRoutes([{ id: 'walkers' }]));

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.path, 'rules.routes[0].name');
    assert.equal(issues[0]?.code, 'missing');
  });

  it('turns away two routes sharing an id', () => {
    const issues = issuesOf(
      withRoutes([
        { id: 'walkers', name: 'The walkers' },
        { id: 'walkers', name: 'The walkers again' },
      ]),
    );

    assert.equal(issues.length, 1);
    assert.equal(issues[0]?.code, 'duplicate-id');
    assert.equal(issues[0]?.path, 'rules.routes[1].id');
  });
});
