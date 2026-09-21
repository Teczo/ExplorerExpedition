/**
 * Standing the expedition endpoints up, for EXPD-017's tests.
 *
 * The tests here send real requests with real tokens, because most of what
 * this ticket promises is about the stack in front of the handler rather than
 * about the handler: another organisation's expedition is not found, a
 * facilitator cannot publish, and the entry in the audit log names whoever
 * really called. A test that called the service directly would prove none of
 * that.
 *
 * `documentFor` is the plainest valid Expedition Definition there is — one
 * mission on one stop, start to mission to finish. It is the same shape the
 * schema's own tests use (EXPD-002), written out again here rather than
 * imported, because a fixture shared between two packages is a fixture that
 * quietly stops one of them from failing.
 */

import type { Express } from 'express';
import type { JsonObject, OrganisationId } from '@explorer/shared-types';

import { createApp } from '../../src/app.ts';
import { signAccessToken, signingKey } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { FakeDatabase } from '../support/fake-database.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';

export { ORG_A, ORG_B };

/** The settings the tests sign their own tokens with. */
export const CONFIG: AuthConfig = {
  signingKey: signingKey('e'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

/** The staff account most of these tests act as. */
export const AUTHOR = '44444444-4444-4444-8444-444444444444';

/** A second staff account, for the tests about who changed what. */
export const OTHER_AUTHOR = '55555555-5555-4555-8555-555555555555';

/** The whole API, with a database that keeps its rows in memory. */
export function expeditionApp(db: FakeDatabase): Express {
  return createApp({ db, authConfig: CONFIG });
}

/** A token for a staff account acting for one organisation. */
export function token(
  organisationId: OrganisationId | string,
  options: { readonly role?: string; readonly userId?: string } = {},
): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: options.userId ?? AUTHOR,
      aud: 'user',
      org: organisationId,
      role: options.role ?? 'org-admin',
      sid: 'membership-1',
    },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/** A request with a bearer token and, when there is one, a JSON body. */
export function as(
  bearer: string,
  init: { readonly method?: string; readonly body?: unknown } = {},
): RequestInit {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}` };
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  return {
    method: init.method ?? 'GET',
    headers,
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  };
}

/** The plainest valid document there is: one mission, one stop. */
export function documentFor(over: Record<string, unknown> = {}): JsonObject {
  return {
    schemaVersion: '1.1.0',
    id: 'whatever-the-client-called-it',
    definitionVersion: 99,
    status: 'published',
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
        organisationId: 'an-organisation-the-caller-made-up',
        createdBy: 'somebody-else',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedBy: 'somebody-else',
        updatedAt: '2020-01-01T00:00:00.000Z',
        source: 'import',
      },
    },
    missions: [
      {
        id: 'alpha',
        missionTypeId: 'code-match',
        missionTypeVersion: '1.0.0',
        title: 'Find the code',
        brief: 'Look for it.',
        config: { answer: '42' },
        scoring: { basePoints: 100, allowPartialCredit: false },
        attempts: { maxAttempts: null },
        verification: 'automatic',
        hints: [{ id: 'hint-1', text: 'Look up.', order: 0, tokenCost: 1 }],
        media: [],
      },
    ],
    graph: {
      nodes: [
        { id: 'start', title: 'Start', kind: 'start' },
        {
          id: 'node-alpha',
          title: 'The code',
          kind: 'mission',
          missionInstanceId: 'alpha',
        },
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
      teams: {
        size: { min: 2, max: 4 },
        maxTeams: null,
        roles: [],
        requireFullTeamToStart: false,
      },
      timing: { startMode: 'synchronised', endMode: 'teacher-ends' },
      hints: { enabled: true, tokensPerTeam: 2 },
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
  } as JsonObject;
}

/**
 * The same document with something missing, so it cannot be published.
 *
 * A mission listed but placed on no node: valid enough to save as a draft,
 * and refused by `validateExpeditionDefinition` the moment somebody tries to
 * publish it.
 */
export function unfinishedDocument(): JsonObject {
  const document = documentFor();
  const graph = document['graph'] as { nodes: { id: string }[] };
  return documentFor({
    graph: {
      nodes: graph.nodes.filter((node) => node.id !== 'node-alpha'),
      edges: [{ id: 'e1', from: 'start', to: 'finish' }],
    },
  });
}

/** A running API, and the two calls a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  request(path: string, init?: RequestInit): Promise<Answer>;
  close(): Promise<void>;
}

/** Starts the API on a free port with an empty database. */
export async function harness(): Promise<Harness> {
  const db = new FakeDatabase();
  const app = await listen(expeditionApp(db));
  return {
    db,
    app,
    request: (path, init) => send(app, path, init ?? {}),
    close: () => app.close(),
  };
}

/** Creates an expedition and answers with its id. */
export async function createExpedition(
  harnessed: Harness,
  document: JsonObject = documentFor(),
  bearer = token(ORG_A),
): Promise<{ readonly id: string; readonly answer: Answer }> {
  const answer = await harnessed.request(
    '/expeditions',
    as(bearer, { method: 'POST', body: { definition: document } }),
  );
  const definition = answer.body['definition'] as Record<string, unknown> | undefined;
  return { id: String(definition?.['id'] ?? ''), answer };
}
