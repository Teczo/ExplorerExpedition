/**
 * The organisation is inside the signature (EXPD-005).
 *
 * Everything else in this directory tests what happens once the API knows
 * which organisation a request acts for. This file tests where that answer
 * comes from, because a repository perfectly scoped to the wrong organisation
 * is not isolation at all.
 *
 * The claim EXPD-004 makes is that no header a caller sends can change it:
 * `org` is signed, so editing it invalidates the token. These tests do the
 * editing, to check that it does.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_SECRET_BYTES,
  bearerToken,
  signAccessToken,
  signingKey,
  verifyAccessToken,
} from '../../src/auth/tokens.ts';
import { ORG_A, ORG_B } from '../support/organisations.ts';

const KEY = signingKey('a'.repeat(MIN_SECRET_BYTES));
const OTHER_KEY = signingKey('b'.repeat(MIN_SECRET_BYTES));
const NOW = new Date('2026-03-01T09:00:00.000Z');
const FIFTEEN_MINUTES = 15 * 60;

/** Signs a staff token for one organisation. */
function tokenFor(organisationId: string): string {
  return signAccessToken(
    KEY,
    { sub: 'user-1', aud: 'user', org: organisationId, role: 'creator', sid: 'membership-1' },
    FIFTEEN_MINUTES,
    NOW,
  );
}

/** Rewrites a claim in a token without re-signing it. */
function rewriteClaim(token: string, claim: string, value: unknown): string {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
  claims[claim] = value;
  const rewritten = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${header}.${rewritten}.${signature}`;
}

describe('a token names one organisation', () => {
  test('and the check reads it back', () => {
    const result = verifyAccessToken(KEY, tokenFor(ORG_A), 'user', NOW);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.claims.org, ORG_A);
  });

  test('two organisations produce two different tokens for the same person', () => {
    assert.notEqual(tokenFor(ORG_A), tokenFor(ORG_B));
  });
});

describe('editing the organisation in a token', () => {
  test('is caught by the signature', () => {
    const forged = rewriteClaim(tokenFor(ORG_A), 'org', ORG_B);
    const result = verifyAccessToken(KEY, forged, 'user', NOW);

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.problem, 'bad-signature');
  });

  test('is caught even when the new organisation is the same length', () => {
    // Same length, so nothing about the encoding gives it away.
    assert.equal(ORG_A.length, ORG_B.length);
    const result = verifyAccessToken(KEY, rewriteClaim(tokenFor(ORG_A), 'org', ORG_B), 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'bad-signature');
  });

  test('removing it altogether is caught as well', () => {
    const [header, payload, signature] = tokenFor(ORG_A).split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    delete claims['org'];
    const stripped = `${header}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}.${signature}`;

    assert.equal(verifyAccessToken(KEY, stripped, 'user', NOW).ok, false);
  });

  test('re-signing with another key does not help', () => {
    const forged = signAccessToken(
      OTHER_KEY,
      { sub: 'user-1', aud: 'user', org: ORG_B, role: 'org-admin', sid: 'membership-1' },
      FIFTEEN_MINUTES,
      NOW,
    );
    const result = verifyAccessToken(KEY, forged, 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'bad-signature');
  });

  test('a token with no org claim at all is refused', () => {
    const noOrg = signAccessToken(
      KEY,
      { sub: 'user-1', aud: 'user' } as never,
      FIFTEEN_MINUTES,
      NOW,
    );
    const result = verifyAccessToken(KEY, noOrg, 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'bad-claims');
  });
});

describe('the header cannot be negotiated', () => {
  test('alg: none is refused as the wrong type, not accepted unsigned', () => {
    const [, payload] = tokenFor(ORG_A).split('.') as [string, string, string];
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'EXPD1' }), 'utf8').toString(
      'base64url',
    );
    const result = verifyAccessToken(KEY, `${header}.${payload}.`, 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'wrong-type');
  });

  test('a token from another system is refused', () => {
    const [, payload, signature] = tokenFor(ORG_A).split('.') as [string, string, string];
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'utf8').toString(
      'base64url',
    );
    const result = verifyAccessToken(KEY, `${header}.${payload}.${signature}`, 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'wrong-type');
  });

  for (const nonsense of ['', 'not-a-token', 'a.b', 'a.b.c.d']) {
    test(`${JSON.stringify(nonsense)} is malformed`, () => {
      const result = verifyAccessToken(KEY, nonsense, 'user', NOW);
      assert.equal(result.ok === false && result.problem, 'malformed');
    });
  }
});

describe('a phone’s token is not a member of staff’s', () => {
  const deviceToken = signAccessToken(
    KEY,
    { sub: 'participant-1', aud: 'device', org: ORG_A, ses: 'run-1', dev: 'device-1' },
    FIFTEEN_MINUTES,
    NOW,
  );

  test('a device token presented as a staff token is refused', () => {
    const result = verifyAccessToken(KEY, deviceToken, 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'wrong-audience');
  });

  test('a staff token presented as a device token is refused', () => {
    const result = verifyAccessToken(KEY, tokenFor(ORG_A), 'device', NOW);

    assert.equal(result.ok === false && result.problem, 'wrong-audience');
  });

  test('rewriting the audience is caught by the signature', () => {
    const forged = rewriteClaim(deviceToken, 'aud', 'user');
    const result = verifyAccessToken(KEY, forged, 'user', NOW);

    assert.equal(result.ok === false && result.problem, 'bad-signature');
  });
});

describe('a token stops working', () => {
  test('once its expiry has passed', () => {
    const later = new Date(NOW.getTime() + (FIFTEEN_MINUTES + 1) * 1000);
    const result = verifyAccessToken(KEY, tokenFor(ORG_A), 'user', later);

    assert.equal(result.ok === false && result.problem, 'expired');
  });

  test('and extending the expiry is caught by the signature', () => {
    const forged = rewriteClaim(tokenFor(ORG_A), 'exp', 4_102_444_800);
    const later = new Date(NOW.getTime() + (FIFTEEN_MINUTES + 1) * 1000);
    const result = verifyAccessToken(KEY, forged, 'user', later);

    assert.equal(result.ok === false && result.problem, 'bad-signature');
  });
});

describe('the signing secret', () => {
  test('has to be long enough to be worth signing with', () => {
    assert.throws(() => signingKey('too short'), /at least 32 bytes/);
  });

  test('is accepted at exactly the minimum', () => {
    assert.doesNotThrow(() => signingKey('c'.repeat(MIN_SECRET_BYTES)));
  });
});

describe('reading the token off the request', () => {
  test('takes it from a Bearer header', () => {
    assert.equal(bearerToken('Bearer abc.def.ghi'), 'abc.def.ghi');
  });

  for (const header of [undefined, '', 'abc.def.ghi', 'Basic abc', 'Bearer ', 'Bearer a b']) {
    test(`returns null for ${JSON.stringify(header)}`, () => {
      assert.equal(bearerToken(header), null);
    });
  }
});
