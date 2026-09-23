/**
 * The signed media URL endpoints (EXPD-021), over real sockets and real
 * tokens.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASHA,
  FixedKeySource,
  MEDIA_A,
  MEDIA_A_DELETED,
  MEDIA_A_FAILED,
  MEDIA_B,
  MISSING_ID,
  NOW,
  ORG_A,
  TEACHER,
  harness,
  phone,
  signedUrlIn,
  staff,
  storage,
} from './support.ts';

const PHOTO = { kind: 'image', contentType: 'image/jpeg' };

describe('POST /media/uploads', () => {
  test('a phone is given a URL that creates one blob, for fifteen minutes', async () => {
    const h = await harness();
    try {
      const answer = await h.upload(phone(ASHA), PHOTO);
      assert.equal(answer.status, 201);
      assert.equal(answer.headers.get('cache-control'), 'no-store');

      const media = answer.body['media'] as Record<string, unknown>;
      assert.equal(media['kind'], 'image');
      assert.equal(media['status'], 'pending');
      assert.equal(media['contentType'], 'image/jpeg');

      const upload = answer.body['upload'] as Record<string, unknown>;
      assert.equal(upload['method'], 'PUT');
      assert.deepEqual(upload['headers'], {
        'x-ms-blob-type': 'BlockBlob',
        'content-type': 'image/jpeg',
      });
      assert.equal(upload['expiresAt'], '2026-09-23T10:15:00.000Z');

      const url = signedUrlIn(answer, 'upload');
      assert.equal(url.origin, 'https://stexpdtest.blob.core.windows.net');
      assert.equal(url.pathname, `/media/${ORG_A}/${String(media['id'])}`);
      assert.equal(url.searchParams.get('sp'), 'c');
      assert.equal(url.searchParams.get('sr'), 'b');
      assert.equal(url.searchParams.get('spr'), 'https');
      assert.equal(url.searchParams.get('se'), '2026-09-23T10:15:00Z');
      assert.ok(url.searchParams.get('sig'));
    } finally {
      await h.close();
    }
  });

  test('writes a pending row naming the student, and where the file will be', async () => {
    const h = await harness();
    try {
      const answer = await h.upload(phone(ASHA), PHOTO);
      const id = (answer.body['media'] as Record<string, unknown>)['id'];
      const row = h.rows().find((candidate) => candidate['id'] === id);

      assert.ok(row);
      assert.equal(row['organisation_id'], ORG_A);
      assert.equal(row['status'], 'pending');
      assert.equal(row['storage_container'], 'media');
      assert.equal(row['storage_path'], `${ORG_A}/${String(id)}`);
      assert.equal(row['uploaded_by_participant'], ASHA);
      assert.equal(row['uploaded_by'], null);
    } finally {
      await h.close();
    }
  });

  test('a teacher may upload too, and is recorded as the account', async () => {
    const h = await harness();
    try {
      const answer = await h.upload(staff(), { kind: 'document', contentType: 'Application/PDF' });
      assert.equal(answer.status, 201);
      const id = (answer.body['media'] as Record<string, unknown>)['id'];
      const row = h.rows().find((candidate) => candidate['id'] === id);
      assert.equal(row?.['uploaded_by'], TEACHER);
      assert.equal(row?.['uploaded_by_participant'], null);
      // Stored as media types are compared: in lower case.
      assert.equal(row?.['content_type'], 'application/pdf');
    } finally {
      await h.close();
    }
  });

  test('every upload goes to its own blob', async () => {
    const h = await harness();
    try {
      const first = signedUrlIn(await h.upload(phone(ASHA), PHOTO), 'upload');
      const second = signedUrlIn(await h.upload(phone(ASHA), PHOTO), 'upload');
      assert.notEqual(first.pathname, second.pathname);
    } finally {
      await h.close();
    }
  });

  test('a kind and a type that contradict each other are refused', async () => {
    const h = await harness();
    try {
      const answer = await h.upload(phone(ASHA), { kind: 'image', contentType: 'application/zip' });
      assert.equal(answer.status, 422);
      assert.deepEqual(
        (answer.body['details'] as { path: string }[]).map((issue) => issue.path),
        ['contentType'],
      );
      assert.equal(h.rows().length, 4, 'nothing was written');
    } finally {
      await h.close();
    }
  });

  test('a body that is not a kind and a media type is refused, all at once', async () => {
    const h = await harness();
    try {
      const answer = await h.upload(phone(ASHA), {
        kind: 'hologram',
        contentType: 'jpeg',
        bytes: 12,
      });
      assert.equal(answer.status, 422);
      assert.deepEqual(
        (answer.body['details'] as { path: string }[]).map((issue) => issue.path).sort(),
        ['bytes', 'contentType', 'kind'],
      );
    } finally {
      await h.close();
    }
  });

  test('nobody signed in is refused', async () => {
    const h = await harness();
    try {
      const answer = await h.upload(undefined, PHOTO);
      assert.equal(answer.status, 401);
      assert.equal(h.rows().length, 4);
    } finally {
      await h.close();
    }
  });

  test('Azure refusing the key is a 503, and leaves no row behind', async () => {
    const keys = new FixedKeySource();
    keys.failing = true;
    const h = await harness({ storage: storage(keys) });
    try {
      const answer = await h.upload(phone(ASHA), PHOTO);
      assert.equal(answer.status, 503);
      assert.equal(answer.body['error'], 'service-unavailable');
      // What Azure said is for the log, not for the phone.
      assert.doesNotMatch(answer.text, /AuthorizationPermissionMismatch/);
      assert.equal(h.rows().length, 4);
    } finally {
      await h.close();
    }
  });

  test('with no storage configured, the answer says so rather than 404', async () => {
    const h = await harness({ storage: 'none' });
    try {
      const answer = await h.upload(phone(ASHA), PHOTO);
      assert.equal(answer.status, 503);
      assert.equal(answer.body['error'], 'service-unavailable');
      assert.equal(h.rows().length, 4);
    } finally {
      await h.close();
    }
  });
});

describe('GET /media/:mediaId/download', () => {
  test('a teacher is given a URL that reads the one blob, for its set time', async () => {
    const h = await harness();
    try {
      const answer = await h.download(staff(), MEDIA_A);
      assert.equal(answer.status, 200);
      assert.equal(answer.headers.get('cache-control'), 'no-store');

      const media = answer.body['media'] as Record<string, unknown>;
      assert.deepEqual(media, {
        id: MEDIA_A,
        kind: 'image',
        status: 'ready',
        contentType: 'image/jpeg',
      });

      const download = answer.body['download'] as Record<string, unknown>;
      assert.equal(download['method'], 'GET');
      assert.equal(download['expiresAt'], new Date(NOW.getTime() + 600_000).toISOString());

      const url = signedUrlIn(answer, 'download');
      assert.equal(url.pathname, `/media/${ORG_A}/${MEDIA_A}`);
      assert.equal(url.searchParams.get('sp'), 'r');
    } finally {
      await h.close();
    }
  });

  test('the container and path stay on the server', async () => {
    const h = await harness();
    try {
      const answer = await h.download(staff(), MEDIA_A);
      assert.equal('storagePath' in (answer.body['media'] as object), false);
      assert.equal('storage_path' in (answer.body['media'] as object), false);
    } finally {
      await h.close();
    }
  });

  test('a phone may not ask: it holds no media:read', async () => {
    const h = await harness();
    try {
      const answer = await h.download(phone(ASHA), MEDIA_A);
      assert.equal(answer.status, 403);
    } finally {
      await h.close();
    }
  });

  test("another school's file is not found, and neither is nothing", async () => {
    const h = await harness();
    try {
      assert.equal((await h.download(staff(), MEDIA_B)).status, 404);
      assert.equal((await h.download(staff(), MISSING_ID)).status, 404);
    } finally {
      await h.close();
    }
  });

  test('a deleted file is not found, and a failed one is a conflict', async () => {
    const h = await harness();
    try {
      assert.equal((await h.download(staff(), MEDIA_A_DELETED)).status, 404);
      const failed = await h.download(staff(), MEDIA_A_FAILED);
      assert.equal(failed.status, 409);
      assert.equal(failed.body['error'], 'conflict');
    } finally {
      await h.close();
    }
  });

  test('an id that is not an id is refused before anything is read', async () => {
    const h = await harness();
    try {
      const answer = await h.download(staff(), 'not-a-uuid');
      assert.equal(answer.status, 422);
    } finally {
      await h.close();
    }
  });

  test('a file uploaded a moment ago can be read back by the same school', async () => {
    const h = await harness();
    try {
      const uploaded = await h.upload(phone(ASHA), PHOTO);
      const id = String((uploaded.body['media'] as Record<string, unknown>)['id']);
      const answer = await h.download(staff(), id);
      assert.equal(answer.status, 200);
      assert.equal(signedUrlIn(answer, 'download').pathname, signedUrlIn(uploaded, 'upload').pathname);
    } finally {
      await h.close();
    }
  });
});
