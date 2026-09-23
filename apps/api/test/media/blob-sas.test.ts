/**
 * Signing one blob's URL (EXPD-021).
 *
 * Blob Storage rebuilds the string it expects from the URL and compares
 * signatures, so a field out of place is a URL that is refused with nothing
 * to say why. These tests write the list out again, line by line, from
 * Azure's page for version 2022-11-02, and hold the code to it.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import {
  SAS_VERSION,
  isoSeconds,
  sasQuery,
  signature,
  signedBlobUrl,
  stringToSign,
} from '../../src/media/blob-sas.ts';
import { KEY, request } from './support.ts';

describe('the string a user delegation SAS signs', () => {
  test('is every field Azure lists for 2022-11-02, in order', () => {
    const lines = stringToSign(request()).split('\n');
    assert.deepEqual(lines, [
      'c', // signedPermissions
      '2026-09-23T09:55:00Z', // signedStart
      '2026-09-23T10:15:00Z', // signedExpiry
      '/blob/stexpdtest/media/org-1/photo-1', // canonicalizedResource
      KEY.signedObjectId, // signedKeyObjectId
      KEY.signedTenantId, // signedKeyTenantId
      KEY.signedStart, // signedKeyStart
      KEY.signedExpiry, // signedKeyExpiry
      'b', // signedKeyService
      KEY.signedVersion, // signedKeyVersion
      '', // signedAuthorizedUserObjectId
      '', // signedUnauthorizedUserObjectId
      '', // signedCorrelationId
      '', // signedIP
      'https', // signedProtocol
      '2022-11-02', // signedVersion
      'b', // signedResource
      '', // signedSnapshotTime
      '', // signedEncryptionScope
      '', // rscc
      '', // rscd
      '', // rsce
      '', // rscl
      '', // rsct
    ]);
  });

  test('names the blob unencoded, under the account and container', () => {
    const lines = stringToSign(request({ blobName: 'a b/c' })).split('\n');
    assert.equal(lines[3], '/blob/stexpdtest/media/a b/c');
  });

  test('is signed with HMAC-SHA256 under the decoded key', () => {
    const expected = createHmac('sha256', Buffer.from(KEY.value, 'base64'))
      .update(stringToSign(request()), 'utf8')
      .digest('base64');
    assert.equal(signature(request()), expected);
  });

  test('a different permission, blob or time is a different signature', () => {
    const base = signature(request());
    assert.notEqual(signature(request({ permission: 'r' })), base);
    assert.notEqual(signature(request({ blobName: 'org-1/photo-2' })), base);
    assert.notEqual(
      signature(request({ expiresAt: new Date('2026-09-23T10:16:00Z') })),
      base,
    );
  });
});

describe('the signed URL', () => {
  test('carries every signed field, and the signature', () => {
    const query = new URLSearchParams(sasQuery(request()));
    assert.deepEqual(Object.fromEntries(query), {
      sv: SAS_VERSION,
      spr: 'https',
      st: '2026-09-23T09:55:00Z',
      se: '2026-09-23T10:15:00Z',
      sr: 'b',
      sp: 'c',
      skoid: KEY.signedObjectId,
      sktid: KEY.signedTenantId,
      skt: KEY.signedStart,
      ske: KEY.signedExpiry,
      sks: 'b',
      skv: KEY.signedVersion,
      sig: signature(request()),
    });
  });

  test('points at the blob under the endpoint, whether or not it ends in a slash', () => {
    for (const endpoint of [
      'https://stexpdtest.blob.core.windows.net/',
      'https://stexpdtest.blob.core.windows.net',
    ]) {
      const url = new URL(signedBlobUrl(endpoint, request()));
      assert.equal(url.origin, 'https://stexpdtest.blob.core.windows.net');
      assert.equal(url.pathname, '/media/org-1/photo-1');
    }
  });

  test('percent-encodes each part of the path, and keeps the slashes', () => {
    const url = new URL(
      signedBlobUrl('https://stexpdtest.blob.core.windows.net/', request({ blobName: 'a b/c#d' })),
    );
    assert.equal(url.pathname, '/media/a%20b/c%23d');
  });
});

test('times are signed to the second, as Azure writes them', () => {
  assert.equal(isoSeconds(new Date('2026-09-23T10:15:00.987Z')), '2026-09-23T10:15:00Z');
});
