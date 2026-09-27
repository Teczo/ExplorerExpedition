import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ApiError, createAuthClient, type Fetch } from '../src/auth/api-client.ts';

function recording(response: Response | Error) {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl: Fetch = async (url, init) => {
    seen.push({ url, init });
    if (response instanceof Error) {
      throw response;
    }
    return response;
  };
  return { seen, fetchImpl };
}

test('sign-in posts JSON to the API root it was given', async () => {
  const { seen, fetchImpl } = recording(Response.json({ refreshToken: 'r' }));
  const client = createAuthClient('/api', fetchImpl);

  const answer = await client.signIn('ada@example.com', 'secret');

  assert.equal(answer.refreshToken, 'r');
  assert.equal(seen[0]?.url, '/api/auth/sign-in');
  assert.equal(seen[0]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(seen[0]?.init?.body)), {
    email: 'ada@example.com',
    password: 'secret',
  });
});

test('me sends the access token as a bearer token', async () => {
  const { seen, fetchImpl } = recording(Response.json({ principal: {}, permissions: [] }));
  await createAuthClient('/api', fetchImpl).me('tok');
  assert.deepEqual(seen[0]?.init?.headers, { Authorization: 'Bearer tok' });
});

test('a refusal becomes an ApiError carrying the stable code and the message', async () => {
  const { fetchImpl } = recording(
    Response.json({ error: 'bad-credentials', message: 'Nope.' }, { status: 401 }),
  );
  await assert.rejects(createAuthClient('/api', fetchImpl).signIn('a', 'b'), (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.status, 401);
    assert.equal(error.code, 'bad-credentials');
    assert.equal(error.message, 'Nope.');
    return true;
  });
});

test('an answer that is not the error contract still becomes an ApiError', async () => {
  const { fetchImpl } = recording(new Response('<html>bad gateway</html>', { status: 502 }));
  await assert.rejects(createAuthClient('/api', fetchImpl).refresh('r'), {
    name: 'ApiError',
    status: 502,
    code: 'unexpected-answer',
  });
});

test('no answer at all is a network error', async () => {
  const { fetchImpl } = recording(new TypeError('Failed to fetch'));
  await assert.rejects(createAuthClient('/api', fetchImpl).refresh('r'), {
    status: 0,
    code: 'network-error',
  });
});

test('sign-out reads a 204 with no body', async () => {
  const { fetchImpl } = recording(new Response(null, { status: 204 }));
  await createAuthClient('/api', fetchImpl).signOut('r');
});
