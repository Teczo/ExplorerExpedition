import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Fetch } from '../src/auth/api-client.ts';
import { AuthSession, STORAGE_KEYS } from '../src/auth/session.ts';
import {
  FakeAuthClient,
  MemoryStorage,
  accessToken,
  apiError,
  meFor,
  organisation,
  signInAnswer,
} from './support.ts';

function setup(options: { fetch?: Fetch; now?: () => number } = {}) {
  const client = new FakeAuthClient();
  const storage = new MemoryStorage();
  const session = new AuthSession({
    client,
    storage,
    baseUrl: '/api',
    fetch: options.fetch,
    now: options.now ?? (() => Date.parse('2026-01-01T00:00:00Z')),
  });
  return { client, storage, session };
}

// --- Signing in ---

test('it starts loading, and with nothing stored it goes to the sign-in page without calling the API', async () => {
  const { client, session } = setup();
  assert.equal(session.getState().status, 'loading');

  await session.restore();

  assert.deepEqual(session.getState(), { status: 'signed-out', error: null });
  assert.deepEqual(client.calls, []);
});

test('a platform admin with one organisation goes straight into the Studio', async () => {
  const { client, storage, session } = setup();
  client.onSignIn = async () => signInAnswer();

  await session.signIn('ada@example.com', 'secret');

  const state = session.getState();
  assert.equal(state.status, 'signed-in');
  assert.equal(state.status === 'signed-in' && state.organisation.name, 'Organisation org-a');
  assert.equal(state.status === 'signed-in' && state.displayName, 'Ada');
  assert.deepEqual(client.calls, ['signIn', 'me']);
  assert.equal(storage.getItem(STORAGE_KEYS.refreshToken), 'refresh-1');
  assert.equal(storage.getItem(STORAGE_KEYS.organisationId), 'org-a');
});

test('the access token is never written to storage', async () => {
  const { client, storage, session } = setup();
  client.onSignIn = async () => signInAnswer();

  await session.signIn('ada@example.com', 'secret');

  for (const value of storage.values.values()) {
    assert.ok(!value.includes('access-for'), `storage holds ${value}`);
  }
});

test('somebody who is not a platform admin is refused, and their sign-in is ended at once', async () => {
  const { client, storage, session } = setup();
  client.onSignIn = async () => signInAnswer({ isPlatformAdmin: false });

  await session.signIn('teacher@example.com', 'secret');

  assert.deepEqual(session.getState(), { status: 'denied', displayName: 'Ada' });
  assert.deepEqual(client.signedOut, ['refresh-1']);
  assert.ok(!client.calls.includes('me'));
  assert.equal(storage.values.size, 0);
});

test('when the server says the token does not carry the permission, it is refused too', async () => {
  const { client, storage, session } = setup();
  client.onSignIn = async () => signInAnswer();
  client.onMe = async () => meFor('org-a', false);

  await session.signIn('ada@example.com', 'secret');

  assert.equal(session.getState().status, 'denied');
  assert.deepEqual(client.signedOut, ['refresh-1']);
  assert.equal(storage.values.size, 0);
});

test('a wrong password shows what the API said', async () => {
  const { client, session } = setup();
  client.onSignIn = async () => {
    throw apiError(401, 'bad-credentials', 'That email address and password do not match an account.');
  };

  await session.signIn('ada@example.com', 'wrong');

  assert.deepEqual(session.getState(), {
    status: 'signed-out',
    error: 'That email address and password do not match an account.',
  });
});

test('a platform admin with no organisation cannot get a token, so is signed out with a reason', async () => {
  const { client, session } = setup();
  client.onSignIn = async () => signInAnswer({ organisations: [], accessToken: null });

  await session.signIn('ada@example.com', 'secret');

  const state = session.getState();
  assert.equal(state.status, 'signed-out');
  assert.match(state.status === 'signed-out' ? String(state.error) : '', /not a member/);
  assert.deepEqual(client.signedOut, ['refresh-1']);
});

// --- Organisations ---

test('with several organisations the person picks one', async () => {
  const { client, storage, session } = setup();
  client.onSignIn = async () =>
    signInAnswer({ organisations: [organisation('org-a'), organisation('org-b')], accessToken: null });

  await session.signIn('ada@example.com', 'secret');
  assert.equal(session.getState().status, 'choosing-organisation');

  await session.chooseOrganisation(organisation('org-b').organisationId);

  const state = session.getState();
  assert.equal(state.status === 'signed-in' && state.organisation.organisationId, 'org-b');
  assert.equal(storage.getItem(STORAGE_KEYS.organisationId), 'org-b');
});

test('a refused organisation keeps the picker open with the reason', async () => {
  const { client, session } = setup();
  client.onSignIn = async () =>
    signInAnswer({ organisations: [organisation('org-a'), organisation('org-b')], accessToken: null });
  client.onAccessToken = async () => {
    throw apiError(403, 'not-a-member', 'You do not have access to that organisation.');
  };

  await session.signIn('ada@example.com', 'secret');
  await session.chooseOrganisation(organisation('org-a').organisationId);

  const state = session.getState();
  assert.equal(state.status, 'choosing-organisation');
  assert.equal(
    state.status === 'choosing-organisation' && state.error,
    'You do not have access to that organisation.',
  );
});

test('switching organisation goes back to the picker without signing out', async () => {
  const { client, session } = setup();
  client.onSignIn = async () =>
    signInAnswer({ organisations: [organisation('org-a'), organisation('org-b')] });

  await session.signIn('ada@example.com', 'secret');
  session.switchOrganisation();

  assert.equal(session.getState().status, 'choosing-organisation');
  assert.deepEqual(client.signedOut, []);
});

// --- Surviving a reload ---

test('a reload rotates the stored refresh token once, even when asked twice', async () => {
  const { client, storage, session } = setup();
  storage.setItem(STORAGE_KEYS.refreshToken, 'refresh-1');
  storage.setItem(STORAGE_KEYS.displayName, 'Ada');
  storage.setItem(STORAGE_KEYS.organisationId, 'org-b');
  client.onRefresh = async () => ({
    userId: 'user-1' as never,
    refreshToken: 'refresh-2',
    refreshTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    organisations: [organisation('org-a'), organisation('org-b')],
  });

  await Promise.all([session.restore(), session.restore()]);

  assert.deepEqual(client.calls, ['refresh:refresh-1', 'accessToken:org-b', 'me']);
  assert.equal(storage.getItem(STORAGE_KEYS.refreshToken), 'refresh-2');
  const state = session.getState();
  assert.equal(state.status === 'signed-in' && state.organisation.organisationId, 'org-b');
  assert.equal(state.status === 'signed-in' && state.displayName, 'Ada');
});

test('a stored sign-in that has ended goes quietly to the sign-in page and is forgotten', async () => {
  const { client, storage, session } = setup();
  storage.setItem(STORAGE_KEYS.refreshToken, 'refresh-1');
  client.onRefresh = async () => {
    throw apiError(401, 'session-ended');
  };

  await session.restore();

  assert.deepEqual(session.getState(), { status: 'signed-out', error: null });
  assert.equal(storage.values.size, 0);
});

// --- Tokens and calls ---

test('an access token close to expiry is minted again, once for callers asking together', async () => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const { client, session } = setup({ now: () => now });
  client.onSignIn = async () => signInAnswer({ accessToken: accessToken('org-a', '2026-01-01T00:15:00Z') });
  await session.signIn('ada@example.com', 'secret');

  assert.equal(await session.accessToken(), 'access-for-org-a');
  assert.equal(client.calls.filter((each) => each.startsWith('accessToken')).length, 0);

  now = Date.parse('2026-01-01T00:14:30Z');
  client.onAccessToken = async () => accessToken('org-a', '2026-01-01T00:30:00Z', 'fresh');
  const [first, second] = await Promise.all([session.accessToken(), session.accessToken()]);

  assert.equal(first, 'fresh');
  assert.equal(second, 'fresh');
  assert.equal(client.calls.filter((each) => each.startsWith('accessToken')).length, 1);
});

test('request sends the bearer token to the API root', async () => {
  const seen: { url: string; headers: Headers }[] = [];
  const { client, session } = setup({
    fetch: async (url, init) => {
      seen.push({ url, headers: new Headers(init?.headers) });
      return Response.json({ ok: true });
    },
  });
  client.onSignIn = async () => signInAnswer();
  await session.signIn('ada@example.com', 'secret');

  const answer = await session.request<{ ok: boolean }>('/expeditions');

  assert.deepEqual(answer, { ok: true });
  assert.equal(seen[0]?.url, '/api/expeditions');
  assert.equal(seen[0]?.headers.get('Authorization'), 'Bearer access-for-org-a');
});

test('a 401 from any call ends the sign-in', async () => {
  const { client, storage, session } = setup({
    fetch: async () => Response.json({ error: 'bad-token', message: 'x' }, { status: 401 }),
  });
  client.onSignIn = async () => signInAnswer();
  await session.signIn('ada@example.com', 'secret');

  await assert.rejects(session.request('/expeditions'), { status: 401 });

  assert.equal(session.getState().status, 'signed-out');
  assert.equal(storage.values.size, 0);
});

// --- Signing out ---

test('signing out tells the API and forgets everything', async () => {
  const { client, storage, session } = setup();
  client.onSignIn = async () => signInAnswer();
  await session.signIn('ada@example.com', 'secret');

  await session.signOut();

  assert.deepEqual(session.getState(), { status: 'signed-out', error: null });
  assert.deepEqual(client.signedOut, ['refresh-1']);
  assert.equal(storage.values.size, 0);
  await assert.rejects(session.accessToken(), { status: 401 });
});

test('listeners hear every change and can stop listening', async () => {
  const { client, session } = setup();
  client.onSignIn = async () => signInAnswer();
  let heard = 0;
  const stop = session.subscribe(() => {
    heard += 1;
  });

  await session.signIn('ada@example.com', 'secret');
  stop();
  await session.signOut();

  assert.equal(heard, 1);
});
