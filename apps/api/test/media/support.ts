/**
 * Standing the media endpoints up, for EXPD-021's tests.
 *
 * Nothing here reaches Azure. The signing is real — the same code signs a
 * URL here as in production — but the key it signs with is a fixed one
 * handed over by a key source that makes no call, and the two calls the real
 * key source makes are answered by a fake `fetch` in `delegation-key.test.ts`.
 *
 * What these tests cannot prove is that Blob Storage accepts the URL. That
 * takes a storage account, and the test run has none.
 */

import type { Express } from 'express';

import { createApp } from '../../src/app.ts';
import type { BlobSasRequest, UserDelegationKey } from '../../src/media/blob-sas.ts';
import {
  StorageSigningError,
  type DelegationKeySource,
} from '../../src/media/delegation-key.ts';
import { BlobMediaStorage, type MediaStorage } from '../../src/media/media-storage.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import { CONFIG, ORG_A, ORG_B } from '../play/support.ts';

export { ORG_A, ORG_B };
export { phone, staff, ASHA, TEACHER } from '../play/support.ts';

/** A delegation key as Blob Storage would hand one over. Not a real one. */
export const KEY: UserDelegationKey = {
  signedObjectId: '0f0f0f0f-0000-4000-8000-00000000a11d',
  signedTenantId: '7e7e7e7e-0000-4000-8000-0000000000e7',
  signedStart: '2026-09-23T09:00:00Z',
  signedExpiry: '2026-09-24T09:00:00Z',
  signedService: 'b',
  signedVersion: '2022-11-02',
  value: Buffer.from('a test key, thirty-two bytes long').toString('base64'),
};

/** One signature's worth of fields, changed as a test needs. */
export function request(overrides: Partial<BlobSasRequest> = {}): BlobSasRequest {
  return {
    accountName: 'stexpdtest',
    containerName: 'media',
    blobName: 'org-1/photo-1',
    permission: 'c',
    startsAt: new Date('2026-09-23T09:55:00Z'),
    expiresAt: new Date('2026-09-23T10:15:00Z'),
    key: KEY,
    ...overrides,
  };
}

export const ENDPOINT = 'https://stexpdtest.blob.core.windows.net/';
/** The time every test's clock stands at. */
export const NOW = new Date('2026-09-23T10:00:00Z');

/** Hands over `KEY`, or refuses the way Azure being down would. */
export class FixedKeySource implements DelegationKeySource {
  failing = false;

  async keyValidUntil(): Promise<UserDelegationKey> {
    if (this.failing) {
      throw new StorageSigningError('Blob Storage answered 403: AuthorizationPermissionMismatch');
    }
    return KEY;
  }
}

/** Real signing, with a fixed key and a fixed clock. */
export function storage(keys: DelegationKeySource = new FixedKeySource()): BlobMediaStorage {
  return new BlobMediaStorage({
    accountName: 'stexpdtest',
    blobEndpoint: ENDPOINT,
    container: 'media',
    keys,
    uploadUrlSeconds: 900,
    downloadUrlSeconds: 600,
    now: () => NOW,
  });
}

export const MEDIA_A = 'a0000000-0000-4000-8000-0000000000a1';
export const MEDIA_A_DELETED = 'a0000000-0000-4000-8000-0000000000a2';
export const MEDIA_A_FAILED = 'a0000000-0000-4000-8000-0000000000a3';
export const MEDIA_B = 'b0000000-0000-4000-8000-0000000000b1';
export const MISSING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function asset(id: string, organisationId: string, status: string): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    kind: 'image',
    status,
    storage_container: 'media',
    storage_path: `${organisationId}/${id}`,
    content_type: 'image/jpeg',
    uploaded_by: null,
    uploaded_by_participant: null,
    created_at: NOW,
  };
}

/** A running API, and the calls a test makes against it. */
export interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  upload(bearer: string | undefined, body: unknown): Promise<Answer>;
  download(bearer: string | undefined, mediaId: string): Promise<Answer>;
  rows(): readonly FakeRow[];
  close(): Promise<void>;
}

/** The whole API, with a few files already in each school's storage. */
export function mediaApp(db: FakeDatabase, mediaStorage: MediaStorage | undefined): Express {
  return createApp({
    db,
    authConfig: CONFIG,
    // A 503 is logged, as it should be; the test run does not need to read it.
    log: () => {},
    ...(mediaStorage === undefined ? {} : { mediaStorage }),
  });
}

export async function harness(
  options: { readonly storage?: MediaStorage | 'none' } = {},
): Promise<Harness> {
  const db = new FakeDatabase();
  db.seed(
    'media_asset',
    asset(MEDIA_A, ORG_A, 'ready'),
    asset(MEDIA_A_DELETED, ORG_A, 'deleted'),
    asset(MEDIA_A_FAILED, ORG_A, 'failed'),
    asset(MEDIA_B, ORG_B, 'ready'),
  );
  const chosen = options.storage === 'none' ? undefined : (options.storage ?? storage());
  const app = await listen(mediaApp(db, chosen));

  const headers = (bearer: string | undefined): Record<string, string> =>
    bearer === undefined ? {} : { authorization: `Bearer ${bearer}` };

  return {
    db,
    app,
    upload: (bearer, body) =>
      send(app, '/media/uploads', {
        method: 'POST',
        headers: { ...headers(bearer), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    download: (bearer, mediaId) =>
      send(app, `/media/${mediaId}/download`, { headers: headers(bearer) }),
    rows: () => db.rowsIn('media_asset'),
    close: () => app.close(),
  };
}

/** The signed URL out of an answer, taken apart. */
export function signedUrlIn(answer: Answer, field: 'upload' | 'download'): URL {
  const grant = answer.body[field] as Record<string, unknown>;
  return new URL(String(grant['url']));
}
