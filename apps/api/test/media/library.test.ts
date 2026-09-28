/**
 * The media library endpoints (EXPD-030), over real sockets and real tokens.
 *
 * Blob Storage is a fake `fetch` that answers the `HEAD` the API sends before
 * it calls a file ready. The URLs are signed for real, as in EXPD-021's tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { BlobMediaStorage } from '../../src/media/media-storage.ts';
import { listen, send, type Answer, type RunningApp } from '../http/support.ts';
import { FakeDatabase, type FakeRow } from '../support/fake-database.ts';
import {
  ASHA,
  ENDPOINT,
  FixedKeySource,
  MEDIA_A,
  MISSING_ID,
  NOW,
  ORG_A,
  ORG_B,
  TEACHER,
  mediaApp,
  phone,
  staff,
} from './support.ts';

const LIB_A = 'a0000000-0000-4000-8000-0000000001a1';
const LIB_A_PENDING = 'a0000000-0000-4000-8000-0000000001a2';
const LIB_A_REMOVED = 'a0000000-0000-4000-8000-0000000001a3';
const LIB_B = 'b0000000-0000-4000-8000-0000000001b1';

const CREATOR = staff({ role: 'creator' });

function libraryRow(
  id: string,
  organisationId: string,
  fields: { status?: string; kind?: string; name?: string; createdAt?: Date } = {},
): FakeRow {
  return {
    id,
    organisation_id: organisationId,
    kind: fields.kind ?? 'image',
    status: fields.status ?? 'ready',
    storage_container: 'media',
    storage_path: `${organisationId}/${id}`,
    content_type: fields.kind === 'model' ? 'model/gltf-binary' : 'image/png',
    byte_size: '2048',
    in_library: true,
    name: fields.name ?? 'Map of the park',
    alt_text: null,
    uploaded_by: TEACHER,
    uploaded_by_participant: null,
    created_at: fields.createdAt ?? NOW,
    updated_at: fields.createdAt ?? NOW,
  };
}

/** Blob Storage, as far as a `HEAD` goes: which blobs are there, and their size. */
class FakeBlobs {
  readonly present = new Map<string, number>();
  readonly asked: string[] = [];
  failing = false;

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    assert.equal(init?.method, 'HEAD');
    const url = new URL(input);
    this.asked.push(url.pathname);
    assert.equal(url.searchParams.get('sp'), 'r');
    if (this.failing) {
      return new Response(null, { status: 403 });
    }
    const size = this.present.get(url.pathname);
    return size === undefined
      ? new Response(null, { status: 404 })
      : new Response(null, { status: 200, headers: { 'content-length': String(size), 'content-type': 'image/png' } });
  };
}

interface Harness {
  readonly db: FakeDatabase;
  readonly app: RunningApp;
  readonly blobs: FakeBlobs;
  call(bearer: string, path: string, init?: { method?: string; body?: unknown }): Promise<Answer>;
  row(id: string): FakeRow | undefined;
  audit(): readonly FakeRow[];
  close(): Promise<void>;
}

async function harness(): Promise<Harness> {
  const db = new FakeDatabase();
  db.seed(
    'media_asset',
    libraryRow(LIB_A, ORG_A, { name: 'Older', createdAt: new Date('2026-09-20T10:00:00Z') }),
    libraryRow(LIB_A_PENDING, ORG_A, { status: 'pending', kind: 'model', name: 'Statue' }),
    libraryRow(LIB_A_REMOVED, ORG_A, { status: 'deleted', name: 'Gone' }),
    libraryRow(LIB_B, ORG_B, { name: 'Riverbank only' }),
    // Evidence a team handed in: in the same table, never in the library.
    {
      id: MEDIA_A,
      organisation_id: ORG_A,
      kind: 'image',
      status: 'ready',
      storage_container: 'media',
      storage_path: `${ORG_A}/${MEDIA_A}`,
      content_type: 'image/jpeg',
      uploaded_by: null,
      uploaded_by_participant: ASHA,
      created_at: NOW,
    },
  );
  const blobs = new FakeBlobs();
  const storage = new BlobMediaStorage({
    accountName: 'stexpdtest',
    blobEndpoint: ENDPOINT,
    container: 'media',
    keys: new FixedKeySource(),
    uploadUrlSeconds: 900,
    downloadUrlSeconds: 600,
    now: () => NOW,
    fetch: blobs.fetch,
  });
  const app = await listen(mediaApp(db, storage));

  return {
    db,
    app,
    blobs,
    call: (bearer, path, init = {}) =>
      send(app, path, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${bearer}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    row: (id) => db.rowsIn('media_asset').find((row) => row['id'] === id),
    audit: () => db.rowsIn('audit_log'),
    close: () => app.close(),
  };
}

function mediaOf(answer: Answer): Record<string, unknown> {
  return answer.body['media'] as Record<string, unknown>;
}

describe('GET /media/library', () => {
  test('lists this organisation’s library, newest first, without removed files or evidence', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, '/media/library');
      assert.equal(answer.status, 200);
      const media = answer.body['media'] as Record<string, unknown>[];
      assert.deepEqual(
        media.map((item) => item['name']),
        ['Statue', 'Older'],
      );
      assert.equal(media[1]?.['byteSize'], 2048);
      assert.equal(media[1]?.['storage_path'], undefined);
    } finally {
      await h.close();
    }
  });

  test('narrows to one kind, 3D models included', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, '/media/library?kind=model');
      const media = answer.body['media'] as Record<string, unknown>[];
      assert.deepEqual(media.map((item) => item['id']), [LIB_A_PENDING]);
    } finally {
      await h.close();
    }
  });

  test('a teacher may read it; a phone may not', async () => {
    const h = await harness();
    try {
      assert.equal((await h.call(staff(), '/media/library')).status, 200);
      assert.equal((await h.call(phone(ASHA), '/media/library')).status, 403);
    } finally {
      await h.close();
    }
  });

  test('another organisation’s file, a removed one and evidence are not found', async () => {
    const h = await harness();
    try {
      for (const id of [LIB_B, LIB_A_REMOVED, MEDIA_A, MISSING_ID]) {
        assert.equal((await h.call(CREATOR, `/media/library/${id}`)).status, 404, id);
      }
      assert.equal((await h.call(CREATOR, `/media/library/${LIB_A}`)).status, 200);
    } finally {
      await h.close();
    }
  });
});

describe('POST /media/library', () => {
  const PDF = { kind: 'document', contentType: 'application/pdf', name: 'Safety sheet', altText: 'Rules' };

  test('writes a pending library row and answers with a create-only URL', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, '/media/library', { method: 'POST', body: PDF });
      assert.equal(answer.status, 201);
      assert.equal(answer.headers.get('cache-control'), 'no-store');
      const media = mediaOf(answer);
      assert.equal(media['status'], 'pending');
      assert.equal(media['name'], 'Safety sheet');
      assert.equal(media['altText'], 'Rules');

      const upload = answer.body['upload'] as Record<string, unknown>;
      const url = new URL(String(upload['url']));
      assert.equal(url.pathname, `/media/${ORG_A}/${String(media['id'])}`);
      assert.equal(url.searchParams.get('sp'), 'c');

      const row = h.row(String(media['id']));
      assert.equal(row?.['in_library'], true);
      assert.equal(row?.['uploaded_by'], TEACHER);
      assert.equal(row?.['organisation_id'], ORG_A);
      // Nothing has changed yet that anybody answers for.
      assert.equal(h.audit().length, 0);
    } finally {
      await h.close();
    }
  });

  test('takes a 3D model', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, '/media/library', {
        method: 'POST',
        body: { kind: 'model', contentType: 'model/gltf-binary', name: 'Statue' },
      });
      assert.equal(answer.status, 201, answer.text);
      assert.equal(mediaOf(answer)['kind'], 'model');
    } finally {
      await h.close();
    }
  });

  test('refuses a type that is not the kind, and a missing name', async () => {
    const h = await harness();
    try {
      const wrong = await h.call(CREATOR, '/media/library', {
        method: 'POST',
        body: { kind: 'model', contentType: 'image/png', name: 'Statue' },
      });
      assert.equal(wrong.status, 422);
      const unnamed = await h.call(CREATOR, '/media/library', {
        method: 'POST',
        body: { kind: 'image', contentType: 'image/png', name: '  ' },
      });
      assert.equal(unnamed.status, 422);
    } finally {
      await h.close();
    }
  });

  test('a teacher and a phone may not add to it', async () => {
    const h = await harness();
    try {
      assert.equal((await h.call(staff(), '/media/library', { method: 'POST', body: PDF })).status, 403);
      assert.equal((await h.call(phone(ASHA), '/media/library', { method: 'POST', body: PDF })).status, 403);
    } finally {
      await h.close();
    }
  });
});

describe('POST /media/library/:id/complete', () => {
  test('is refused while the blob has not arrived, and the row stays pending', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, `/media/library/${LIB_A_PENDING}/complete`, { method: 'POST' });
      assert.equal(answer.status, 409);
      assert.equal(h.row(LIB_A_PENDING)?.['status'], 'pending');
      assert.deepEqual(h.blobs.asked, [`/media/${ORG_A}/${LIB_A_PENDING}`]);
    } finally {
      await h.close();
    }
  });

  test('marks it ready with the size storage reports, and audits it once', async () => {
    const h = await harness();
    try {
      h.blobs.present.set(`/media/${ORG_A}/${LIB_A_PENDING}`, 734_003);
      const answer = await h.call(CREATOR, `/media/library/${LIB_A_PENDING}/complete`, { method: 'POST' });
      assert.equal(answer.status, 200);
      assert.equal(mediaOf(answer)['status'], 'ready');
      assert.equal(mediaOf(answer)['byteSize'], 734_003);

      const again = await h.call(CREATOR, `/media/library/${LIB_A_PENDING}/complete`, { method: 'POST' });
      assert.equal(again.status, 200);

      const entries = h.audit();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]?.['action'], 'media.added');
      assert.equal(entries[0]?.['entity_type'], 'media_asset');
      assert.equal(entries[0]?.['entity_id'], LIB_A_PENDING);
    } finally {
      await h.close();
    }
  });

  test('is a 503 when storage refuses to say', async () => {
    const h = await harness();
    try {
      h.blobs.failing = true;
      const answer = await h.call(CREATOR, `/media/library/${LIB_A_PENDING}/complete`, { method: 'POST' });
      assert.equal(answer.status, 503);
      assert.equal(h.row(LIB_A_PENDING)?.['status'], 'pending');
    } finally {
      await h.close();
    }
  });
});

describe('PATCH and DELETE /media/library/:id', () => {
  test('renames a file and sets its alt text, and audits the change', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, `/media/library/${LIB_A}`, {
        method: 'PATCH',
        body: { name: 'Park map', altText: 'A map of the park with the pond in the middle' },
      });
      assert.equal(answer.status, 200);
      assert.equal(mediaOf(answer)['name'], 'Park map');
      assert.equal(h.row(LIB_A)?.['alt_text'], 'A map of the park with the pond in the middle');

      const cleared = await h.call(CREATOR, `/media/library/${LIB_A}`, { method: 'PATCH', body: { altText: '' } });
      assert.equal(mediaOf(cleared)['altText'], null);

      assert.deepEqual(
        h.audit().map((entry) => entry['action']),
        ['media.updated', 'media.updated'],
      );
    } finally {
      await h.close();
    }
  });

  test('removes a file: it leaves the list and its download is not found', async () => {
    const h = await harness();
    try {
      const answer = await h.call(CREATOR, `/media/library/${LIB_A}`, { method: 'DELETE' });
      assert.equal(answer.status, 204);
      assert.equal(h.row(LIB_A)?.['status'], 'deleted');
      assert.equal(h.audit()[0]?.['action'], 'media.deleted');

      const list = await h.call(CREATOR, '/media/library');
      assert.ok(!(list.body['media'] as Record<string, unknown>[]).some((item) => item['id'] === LIB_A));
      assert.equal((await h.call(CREATOR, `/media/${LIB_A}/download`)).status, 404);
      assert.equal((await h.call(CREATOR, `/media/library/${LIB_A}`, { method: 'DELETE' })).status, 404);
    } finally {
      await h.close();
    }
  });

  test('cannot reach another organisation’s file or evidence', async () => {
    const h = await harness();
    try {
      for (const id of [LIB_B, MEDIA_A]) {
        assert.equal((await h.call(CREATOR, `/media/library/${id}`, { method: 'DELETE' })).status, 404, id);
        assert.equal(
          (await h.call(CREATOR, `/media/library/${id}`, { method: 'PATCH', body: { name: 'Mine now' } })).status,
          404,
          id,
        );
      }
      assert.equal(h.row(LIB_B)?.['name'], 'Riverbank only');
      assert.equal(h.row(MEDIA_A)?.['status'], 'ready');
      assert.equal(h.audit().length, 0);
    } finally {
      await h.close();
    }
  });
});
