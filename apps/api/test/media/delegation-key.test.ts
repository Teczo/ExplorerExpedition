/**
 * Getting a user delegation key (EXPD-021).
 *
 * Two calls to Azure, answered here by a fake `fetch` that writes down what
 * it was asked. What these tests hold the code to is the shape of each
 * request, what is kept and for how long, and what happens when Azure says
 * no.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  BlobDelegationKeySource,
  KEY_LIFETIME_SECONDS,
  ManagedIdentityTokenSource,
  STORAGE_RESOURCE,
  StorageSigningError,
  parseDelegationKey,
  type Fetch,
} from '../../src/media/delegation-key.ts';
import { mediaStorageFrom } from '../../src/media/media-storage.ts';
import { ENDPOINT, KEY, NOW } from './support.ts';

interface Call {
  readonly url: URL;
  readonly init: RequestInit;
}

const KEY_XML =
  '<?xml version="1.0" encoding="utf-8"?><UserDelegationKey>' +
  `<SignedOid>${KEY.signedObjectId}</SignedOid>` +
  `<SignedTid>${KEY.signedTenantId}</SignedTid>` +
  `<SignedStart>${KEY.signedStart}</SignedStart>` +
  `<SignedExpiry>${KEY.signedExpiry}</SignedExpiry>` +
  `<SignedService>${KEY.signedService}</SignedService>` +
  `<SignedVersion>${KEY.signedVersion}</SignedVersion>` +
  `<Value>${KEY.value}</Value></UserDelegationKey>`;

/** A fake Azure: the identity endpoint and Blob Storage, and a log of calls. */
function fakeAzure(options: { readonly keyStatus?: number; readonly tokenExpiresOn?: number } = {}) {
  const calls: Call[] = [];
  const fetchImpl: Fetch = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.hostname === 'identity.local') {
      return Response.json({
        access_token: 'token-for-storage',
        expires_on: String(options.tokenExpiresOn ?? NOW.getTime() / 1000 + 3600),
      });
    }
    if (options.keyStatus !== undefined && options.keyStatus !== 200) {
      return new Response('<Error><Code>AuthorizationPermissionMismatch</Code></Error>', {
        status: options.keyStatus,
      });
    }
    return new Response(KEY_XML, { status: 200 });
  };
  return { calls, fetch: fetchImpl };
}

function keySource(azure: ReturnType<typeof fakeAzure>, now: () => Date = () => NOW) {
  const tokens = new ManagedIdentityTokenSource({
    endpoint: 'http://identity.local/msi/token',
    header: 'identity-header-secret',
    fetch: azure.fetch,
    now,
  });
  return new BlobDelegationKeySource({ blobEndpoint: ENDPOINT, tokens, fetch: azure.fetch, now });
}

const SOON = new Date(NOW.getTime() + 15 * 60 * 1000);

describe('asking for a key', () => {
  test('first a token from the managed identity, for Azure Storage', async () => {
    const azure = fakeAzure();
    await keySource(azure).keyValidUntil(SOON);

    const tokenCall = azure.calls[0];
    assert.ok(tokenCall);
    assert.equal(tokenCall.url.searchParams.get('resource'), STORAGE_RESOURCE);
    assert.equal(tokenCall.url.searchParams.get('api-version'), '2019-08-01');
    assert.equal(
      (tokenCall.init.headers as Record<string, string>)['X-IDENTITY-HEADER'],
      'identity-header-secret',
    );
  });

  test('then the key from Blob Storage, with that token, for a day', async () => {
    const azure = fakeAzure();
    const key = await keySource(azure).keyValidUntil(SOON);
    assert.deepEqual(key, KEY);

    const keyCall = azure.calls[1];
    assert.ok(keyCall);
    assert.equal(keyCall.init.method, 'POST');
    assert.equal(keyCall.url.origin, 'https://stexpdtest.blob.core.windows.net');
    assert.equal(keyCall.url.searchParams.get('restype'), 'service');
    assert.equal(keyCall.url.searchParams.get('comp'), 'userdelegationkey');

    const headers = keyCall.init.headers as Record<string, string>;
    assert.equal(headers['authorization'], 'Bearer token-for-storage');
    assert.equal(headers['x-ms-version'], '2022-11-02');

    const expiry = new Date(NOW.getTime() + KEY_LIFETIME_SECONDS * 1000);
    assert.equal(
      keyCall.init.body,
      '<?xml version="1.0" encoding="utf-8"?><KeyInfo>' +
        '<Start>2026-09-23T09:55:00Z</Start>' +
        `<Expiry>${expiry.toISOString().slice(0, 19)}Z</Expiry></KeyInfo>`,
    );
  });

  test('a key is kept, and a burst of uploads costs one round trip', async () => {
    const azure = fakeAzure();
    const source = keySource(azure);
    await Promise.all([source.keyValidUntil(SOON), source.keyValidUntil(SOON)]);
    await source.keyValidUntil(SOON);
    assert.equal(azure.calls.length, 2);
  });

  test('a key that would end before the URL does is replaced', async () => {
    const azure = fakeAzure();
    const source = keySource(azure);
    await source.keyValidUntil(SOON);
    // KEY ends at 2026-09-24T09:00:00Z. A URL ending later needs a new one,
    // and when Azure hands back the same key again, that is refused.
    await assert.rejects(
      source.keyValidUntil(new Date('2026-09-24T09:30:00Z')),
      StorageSigningError,
    );
    assert.equal(azure.calls.filter((call) => call.init.method === 'POST').length, 2);
  });

  test('Blob Storage refusing is a StorageSigningError, carrying what it said', async () => {
    const azure = fakeAzure({ keyStatus: 403 });
    await assert.rejects(keySource(azure).keyValidUntil(SOON), (error: unknown) => {
      assert.ok(error instanceof StorageSigningError);
      assert.match(error.message, /403/);
      assert.match(error.message, /AuthorizationPermissionMismatch/);
      return true;
    });
  });

  test('an unreachable Azure is a StorageSigningError too', async () => {
    const source = keySource({
      calls: [],
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(source.keyValidUntil(SOON), StorageSigningError);
  });

  test('after a failure, the next request asks again', async () => {
    let fail = true;
    const azure = fakeAzure();
    const source = keySource({
      calls: azure.calls,
      fetch: async (input, init) => {
        if (fail) {
          fail = false;
          throw new TypeError('fetch failed');
        }
        return azure.fetch(input, init);
      },
    });
    await assert.rejects(source.keyValidUntil(SOON), StorageSigningError);
    assert.deepEqual(await source.keyValidUntil(SOON), KEY);
  });
});

describe('the managed identity token', () => {
  test('is kept until five minutes before it runs out', async () => {
    const azure = fakeAzure({ tokenExpiresOn: NOW.getTime() / 1000 + 600 });
    let now = NOW;
    const tokens = new ManagedIdentityTokenSource({
      endpoint: 'http://identity.local/msi/token',
      header: 'h',
      fetch: azure.fetch,
      now: () => now,
    });

    await tokens.token();
    await tokens.token();
    assert.equal(azure.calls.length, 1);

    now = new Date(NOW.getTime() + 301_000);
    await tokens.token();
    assert.equal(azure.calls.length, 2);
  });

  test('an answer without a token is a StorageSigningError', async () => {
    const tokens = new ManagedIdentityTokenSource({
      endpoint: 'http://identity.local/msi/token',
      header: 'h',
      fetch: async () => Response.json({ error: 'nope' }),
    });
    await assert.rejects(tokens.token(), StorageSigningError);
  });
});

describe("reading Blob Storage's answer", () => {
  test('reads all seven fields', () => {
    assert.deepEqual(parseDelegationKey(KEY_XML), KEY);
  });

  test('an answer missing one is refused, naming it', () => {
    assert.throws(
      () => parseDelegationKey(KEY_XML.replace(/<Value>.*<\/Value>/, '')),
      /no Value/,
    );
  });
});

test('mediaStorageFrom signs with the key the identity fetched', async () => {
  const azure = fakeAzure();
  const mediaStorage = mediaStorageFrom(
    {
      accountName: 'stexpdtest',
      blobEndpoint: ENDPOINT,
      mediaContainer: 'media',
      identityEndpoint: 'http://identity.local/msi/token',
      identityHeader: 'h',
      uploadUrlSeconds: 900,
      downloadUrlSeconds: 900,
    },
    { fetch: azure.fetch },
  );

  const signed = await mediaStorage.signUpload('org/one');
  const url = new URL(signed.url);
  assert.equal(url.pathname, '/media/org/one');
  assert.equal(url.searchParams.get('skoid'), KEY.signedObjectId);
  assert.equal(azure.calls.length, 2);
});
