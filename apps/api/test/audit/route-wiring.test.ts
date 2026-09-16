/**
 * From a request to an entry (EXPD-006).
 *
 * `AuditLog` is tested on its own elsewhere. This drives it the way a real
 * route will: `authenticate`, `requirePermission`, `tenantScope`, then
 * `auditScope`, over HTTP. What that stack promises is that a handler cannot
 * write an entry naming somebody other than the caller, because it is never
 * given the chance to say who the caller is — the actor comes off the token,
 * the organisation comes off the repository, and neither is a parameter.
 *
 * So the tests send the headers. A token for Portside School and a body
 * asking to be recorded as Riverbank Academy's head teacher, and the entry
 * still says Portside and still says who really called.
 *
 * The route belongs to the test, not to the API. EXPD-016 owns the REST
 * skeleton, and the endpoints that will write entries are each their own
 * ticket; this is the smallest handler that records one.
 */

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import express from 'express';

import { AuthService } from '../../src/auth/auth-service.ts';
import {
  authenticate,
  authErrorHandler,
  requirePermission,
  tenantScope,
} from '../../src/auth/middleware.ts';
import { signAccessToken, signingKey } from '../../src/auth/tokens.ts';
import { auditOf, auditScope, REQUEST_ID_HEADER } from '../../src/audit/context.ts';
import { DEFAULT_LIFETIMES, type AuthConfig } from '../../src/config/auth-config.ts';
import { globalRepository } from '../../src/db/global-repository.ts';
import { tenantRepository } from '../../src/db/tenant-repository.ts';
import { AccountRepository } from '../../src/repositories/account-repository.ts';
import { DeviceRepository } from '../../src/repositories/device-repository.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';

const CONFIG: AuthConfig = {
  signingKey: signingKey('b'.repeat(32)),
  lifetimes: DEFAULT_LIFETIMES,
};

const db = new FakeDatabase();

const service = new AuthService({
  config: CONFIG,
  accounts: new AccountRepository(db, globalRepository(db)),
  devicesFor: (organisationId) =>
    new DeviceRepository(tenantRepository(db, { organisationId })),
});

function staffToken(organisationId: string, userId = 'user-portside'): string {
  return signAccessToken(
    CONFIG.signingKey,
    { sub: userId, aud: 'user', org: organisationId, role: 'org-admin', sid: 'membership-1' },
    DEFAULT_LIFETIMES.accessSeconds,
  );
}

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

/** The smallest route that records something: publish an expedition version. */
const app = express();
app.use(express.json());
app.post(
  '/publish',
  authenticate(service),
  requirePermission('expedition:publish'),
  tenantScope(db),
  auditScope(),
  async (request, response) => {
    const entry = await auditOf(request).record('expedition.published', {
      entityId: 'version-1',
      before: { status: 'draft' },
      after: { status: 'published' },
    });
    response.status(201).json(entry);
  },
);
/** A route a student's phone reaches, to check the other kind of actor. */
app.post(
  '/leave-team',
  authenticate(service),
  requirePermission('attempt:write'),
  tenantScope(db),
  auditScope(),
  async (request, response) => {
    const entry = await auditOf(request).record('participant.team-changed', {
      entityId: 'participant-1',
      before: { team_id: 'team-1', display_name: 'Ana' },
      after: { team_id: null, display_name: 'Ana' },
    });
    response.status(201).json(entry);
  },
);
/** The same route without `auditScope` in front, which should be a mistake. */
app.post('/unscoped', authenticate(service), tenantScope(db), (request, response) => {
  try {
    auditOf(request);
    response.status(200).json({ reached: true });
  } catch (error) {
    response.status(500).json({ message: (error as Error).message });
  }
});
app.use(authErrorHandler());

const server = app.listen(0);
after(() => {
  server.close();
});

beforeEach(() => {
  db.forgetStatements();
});

async function call(
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
  const text = await response.text();
  return {
    status: response.status,
    body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
  };
}

/** The entry the last request wrote. */
function writtenEntry(): FakeRow {
  const last = db.rowsIn('audit_log').at(-1);
  assert.notEqual(last, undefined, 'the request should have written an entry');
  return last as FakeRow;
}

describe('the entry names the caller and their organisation', () => {
  test('a Portside token writes a Portside entry', async () => {
    const result = await call('/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken(ORG_A)}` },
    });

    assert.equal(result.status, 201);
    assert.equal(writtenEntry()['organisation_id'], ORG_A);
    assert.equal(writtenEntry()['actor_user_id'], 'user-portside');
  });

  test('a Riverbank token writes a Riverbank entry', async () => {
    await call('/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken(ORG_B, 'user-riverbank')}` },
    });

    assert.equal(writtenEntry()['organisation_id'], ORG_B);
    assert.equal(writtenEntry()['actor_user_id'], 'user-riverbank');
  });

  test('a body claiming to be somebody else changes nothing', async () => {
    await call('/publish', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staffToken(ORG_A)}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        organisation_id: ORG_B,
        actor_user_id: 'user-riverbank',
        actor_label: 'somebody else',
      }),
    });

    const entry = writtenEntry();
    assert.equal(entry['organisation_id'], ORG_A);
    assert.equal(entry['actor_user_id'], 'user-portside');
    assert.equal(entry['actor_label'], 'user user-portside');
  });

  test('a student’s phone is recorded as the participant, not the device', async () => {
    await call('/leave-team', {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken(ORG_A)}` },
    });

    const entry = writtenEntry();
    assert.equal(entry['actor_kind'], 'participant');
    assert.equal(entry['actor_participant_id'], 'participant-1');
    assert.equal(entry['actor_label'], 'participant participant-1');
  });

  test('a student’s name is not in the entry, on either side', async () => {
    await call('/leave-team', {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken(ORG_A)}` },
    });

    assert.equal(
      JSON.stringify(writtenEntry()).includes('Ana'),
      false,
      'a child’s name must not reach a record that can never be edited',
    );
  });
});

describe('where the request came from', () => {
  test('the request id is carried through to the entry', async () => {
    await call('/publish', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staffToken(ORG_A)}`,
        [REQUEST_ID_HEADER]: 'req-abc',
      },
    });

    assert.equal(writtenEntry()['request_id'], 'req-abc');
  });

  test('a request with no such header still writes its entry', async () => {
    const result = await call('/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken(ORG_A)}` },
    });

    assert.equal(result.status, 201);
    assert.equal(writtenEntry()['request_id'], null);
  });

  test('the caller’s address and client are recorded', async () => {
    await call('/publish', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staffToken(ORG_A)}`,
        'user-agent': 'Studio/1.0',
      },
    });

    const entry = writtenEntry();
    assert.equal(entry['user_agent'], 'Studio/1.0');
    assert.notEqual(entry['ip_address'], null);
  });
});

describe('a route that is wired wrongly says so', () => {
  test('reading the log without auditScope in front is an error, not a silent no-op', async () => {
    const result = await call('/unscoped', {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken(ORG_A)}` },
    });

    assert.equal(result.status, 500);
    assert.match(result.body['message'] as string, /no auditScope\(\) runs in front of it/);
  });

  test('a request with no credentials writes nothing', async () => {
    const before = db.rowsIn('audit_log').length;
    const result = await call('/publish', { method: 'POST' });

    assert.equal(result.status, 401);
    assert.equal(db.rowsIn('audit_log').length, before);
  });

  test('a caller without the permission writes nothing', async () => {
    const before = db.rowsIn('audit_log').length;
    const result = await call('/publish', {
      method: 'POST',
      headers: { authorization: `Bearer ${deviceToken(ORG_A)}` },
    });

    assert.equal(result.status, 403);
    assert.equal(db.rowsIn('audit_log').length, before);
  });
});
