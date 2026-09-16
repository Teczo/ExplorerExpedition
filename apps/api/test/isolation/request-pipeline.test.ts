/**
 * From the wire to the row (EXPD-005).
 *
 * The other files test the pieces. This one puts them together the way a real
 * route does — `authenticate`, then `requirePermission`, then `tenantScope` —
 * and drives it over HTTP, because the promise EXPD-004 makes is about a
 * request, not about a class:
 *
 *   "the organisation is inside the signature, so no header a caller sends
 *    can change it"
 *
 * So the tests send the headers. A token for Portside School, a body and a
 * header and a query string all asking for Riverbank Academy, and the same
 * two rows in the database throughout. Portside's rows come back every time.
 *
 * The route here belongs to the test, not to the API. EXPD-016 owns the REST
 * skeleton and every data endpoint is its own ticket; this is the smallest
 * handler that reads a row, so that the middleware in front of it can be
 * watched doing its job.
 */

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AuthService } from '../../src/auth/auth-service.ts';
import {
  authenticate,
  authErrorHandler,
  requirePermission,
  tenantOf,
  tenantScope,
  principalOf,
} from '../../src/auth/middleware.ts';
import { signAccessToken, signingKey } from '../../src/auth/tokens.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { tenantRepository } from '../../src/db/tenant-repository.ts';
import { globalRepository } from '../../src/db/global-repository.ts';
import { AccountRepository } from '../../src/repositories/account-repository.ts';
import { DeviceRepository } from '../../src/repositories/device-repository.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B, rowId, seedBothOrganisations } from '../support/organisations.ts';

const CONFIG: AuthConfig = {
  signingKey: signingKey('a'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

const db = new FakeDatabase();
seedBothOrganisations(db);

const service = new AuthService({
  config: CONFIG,
  // Nothing here signs in — the tokens below are minted directly — but the
  // service is the real one, wired to the same rows the route reads.
  accounts: new AccountRepository(db, globalRepository(db)),
  devicesFor: (organisationId) =>
    new DeviceRepository(tenantRepository(db, { organisationId })),
});

/** A staff token for one organisation. */
function staffToken(organisationId: string, role = 'creator'): string {
  return signAccessToken(
    CONFIG.signingKey,
    { sub: 'user-1', aud: 'user', org: organisationId, role, sid: 'membership-1' },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/** A student device token for one organisation. */
function deviceToken(organisationId: string): string {
  return signAccessToken(
    CONFIG.signingKey,
    {
      sub: 'participant-1',
      aud: 'device',
      org: organisationId,
      ses: 'run-1',
      dev: 'device-1',
    },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

/**
 * The smallest route that reads rows: authenticate, check a permission, build
 * the tenant repository, and hand back whatever it finds.
 */
const app = express();
app.use(express.json());
app.get(
  '/expeditions',
  authenticate(service),
  requirePermission('expedition:read'),
  tenantScope(db),
  async (request, response) => {
    const rows = await tenantOf(request).find<FakeRow>('expedition');
    response.json({
      actingFor: principalOf(request).organisationId,
      rows,
    });
  },
);
app.post(
  '/teams',
  authenticate(service),
  requirePermission('expedition:write'),
  tenantScope(db),
  async (request, response) => {
    // A different table from the one the read route uses, so that a write in
    // one test cannot change what a later read test expects to find.
    const created = await tenantOf(request).insert<FakeRow>('team', {
      owner: 'written by the test',
    });
    response.status(201).json(created);
  },
);
app.use(authErrorHandler());

const server = app.listen(0);
after(() => {
  server.close();
});

/** Calls the test route and returns the status and the parsed body. */
async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    headers: response.headers,
  };
}

/** The ids of the rows a response carried. */
function idsIn(body: Record<string, unknown>): readonly unknown[] {
  return (body['rows'] as FakeRow[]).map((row) => row['id']);
}

describe('a request reads its own organisation', () => {
  test('a Portside token reads Portside’s rows', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${staffToken(ORG_A)}` },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body['actingFor'], ORG_A);
    assert.deepEqual(idsIn(result.body), [rowId('expedition', 'a')]);
  });

  test('a Riverbank token reads Riverbank’s rows', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${staffToken(ORG_B)}` },
    });

    assert.deepEqual(idsIn(result.body), [rowId('expedition', 'b')]);
  });
});

describe('nothing the caller sends changes which organisation that is', () => {
  for (const [name, init] of Object.entries({
    'a header naming another organisation': {
      headers: {
        authorization: `Bearer ${staffToken(ORG_A)}`,
        'x-organisation-id': ORG_B,
      },
    },
    'a query string naming another organisation': { path: `?organisationId=${ORG_B}` },
    'a second Authorization header value': {
      headers: { authorization: `Bearer ${staffToken(ORG_A)}`, 'x-org': ORG_B },
    },
  } as Record<string, { headers?: Record<string, string>; path?: string }>)) {
    test(name, async () => {
      const result = await call(`/expeditions${init.path ?? ''}`, {
        headers: init.headers ?? { authorization: `Bearer ${staffToken(ORG_A)}` },
      });

      assert.equal(result.status, 200);
      assert.equal(result.body['actingFor'], ORG_A);
      assert.deepEqual(idsIn(result.body), [rowId('expedition', 'a')]);
    });
  }
});

describe('a write goes into the organisation the token names', () => {
  test('and carries that organisation whatever the body asks for', async () => {
    const result = await call('/teams', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staffToken(ORG_A)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ organisation_id: ORG_B }),
    });

    assert.equal(result.status, 201);
    assert.equal(result.body['organisation_id'], ORG_A);
  });
});

describe('a request with no usable token reads nothing', () => {
  test('no Authorization header is 401', async () => {
    const result = await call('/expeditions');

    assert.equal(result.status, 401);
    assert.equal(result.body['error'], 'no-credentials');
    assert.equal(result.headers.get('www-authenticate'), 'Bearer');
  });

  test('a token this platform did not sign is 401', async () => {
    const forged = signAccessToken(
      signingKey('b'.repeat(32)),
      { sub: 'user-1', aud: 'user', org: ORG_B, role: 'org-admin', sid: 'membership-1' },
      DEFAULT_LIFETIMES.accessSeconds,
    );
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${forged}` },
    });

    assert.equal(result.status, 401);
    assert.equal(result.body['error'], 'bad-token');
  });

  test('an expired token is 401', async () => {
    const expired = signAccessToken(
      CONFIG.signingKey,
      { sub: 'user-1', aud: 'user', org: ORG_A, role: 'creator', sid: 'membership-1' },
      60,
      new Date(Date.now() - 120_000),
    );
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${expired}` },
    });

    assert.equal(result.status, 401);
  });

  test('nonsense in the header is 401, not an anonymous request', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: 'Bearer not-a-token' },
    });

    assert.equal(result.status, 401);
  });
});

describe('a student’s phone is held to the same boundary', () => {
  test('a device token is refused by a staff route on permissions', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${deviceToken(ORG_A)}` },
    });

    assert.equal(result.status, 403);
    assert.equal(result.body['error'], 'forbidden');
  });

  test('a device token from another organisation is refused too', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${deviceToken(ORG_B)}` },
    });

    assert.equal(result.status, 403);
  });
});

describe('what a role may do is checked separately from which rows it sees', () => {
  test('a facilitator may read expeditions', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${staffToken(ORG_A, 'facilitator')}` },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(idsIn(result.body), [rowId('expedition', 'a')]);
  });

  test('a facilitator may not create one, in their own organisation or any other', async () => {
    const result = await call('/teams', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staffToken(ORG_A, 'facilitator')}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });

    assert.equal(result.status, 403);
  });

  test('an org-member holds nothing yet', async () => {
    const result = await call('/expeditions', {
      headers: { authorization: `Bearer ${staffToken(ORG_A, 'org-member')}` },
    });

    assert.equal(result.status, 403);
  });
});
