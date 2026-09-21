/**
 * An expedition from first save to second publish (EXPD-017).
 *
 * The ticket is three promises, and this file holds each of them to its word:
 *
 *   1. An expedition can be created, read, changed and listed.
 *   2. A draft may be unfinished; a published revision may not.
 *   3. Publishing freezes a revision — the next change starts a new one, and
 *      the frozen one never moves again.
 *
 * Everything goes over HTTP against the whole app, because the promises are
 * about what a client sees rather than about what a method returns.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  as,
  createExpedition,
  documentFor,
  harness,
  token,
  unfinishedDocument,
  ORG_A,
  type Harness,
} from './support.ts';

let api: Harness;

before(async () => {
  api = await harness();
});

after(async () => {
  await api.close();
});

/** The document on a revision, as the answer carries it. */
function documentIn(body: Record<string, unknown>): Record<string, unknown> {
  return body['definition'] as Record<string, unknown>;
}

/** The revision summary on an answer. */
function versionIn(body: Record<string, unknown>): Record<string, unknown> {
  return body['version'] as Record<string, unknown>;
}

describe('creating one', () => {
  test('answers 201 with revision 1 as a draft, and says where it went', async () => {
    const { id, answer } = await createExpedition(api);

    assert.equal(answer.status, 201);
    assert.equal(answer.headers.get('location'), `/expeditions/${id}`);
    assert.equal(versionIn(answer.body)['definitionVersion'], 1);
    assert.equal(versionIn(answer.body)['status'], 'draft');
    assert.equal(versionIn(answer.body)['title'], 'A walk round the museum');
    assert.deepEqual(answer.body['issues'], []);
  });

  test('overwrites the fields that are the platform’s, not the client’s', async () => {
    const { id, answer } = await createExpedition(api);
    const document = documentIn(answer.body);
    const authoring = (document['metadata'] as Record<string, unknown>)[
      'authoring'
    ] as Record<string, unknown>;

    // The client sent an id, a revision number, a published status and
    // somebody else's name. None of the six survived.
    assert.equal(document['id'], id);
    assert.notEqual(document['id'], 'whatever-the-client-called-it');
    assert.equal(document['definitionVersion'], 1);
    assert.equal(document['status'], 'draft');
    assert.equal(document['publishedAt'], undefined);
    assert.equal(authoring['organisationId'], ORG_A);
    assert.equal(authoring['source'], 'studio');
    assert.notEqual(authoring['createdBy'], 'somebody-else');
  });

  test('refuses a document with no name, and says where the problem is', async () => {
    const nameless = documentFor();
    (nameless['metadata'] as Record<string, unknown>)['title'] = '   ';

    const answer = await api.request(
      '/expeditions',
      as(token(ORG_A), { method: 'POST', body: { definition: nameless } }),
    );

    assert.equal(answer.status, 422);
    assert.equal(answer.body['error'], 'validation-failed');
    assert.deepEqual(answer.body['details'], [
      { path: 'definition.metadata.title', message: 'An expedition needs a name.' },
    ]);
  });
});

describe('a draft may be unfinished', () => {
  test('saves one, and says what is still wrong with it', async () => {
    const { answer } = await createExpedition(api, unfinishedDocument());

    assert.equal(answer.status, 201);
    const issues = answer.body['issues'] as { path: string }[];
    assert.ok(issues.length > 0, 'an unplaced mission should be reported');
    assert.ok(
      issues.every((issue) => issue.path.startsWith('definition')),
      `every path should point into the document, got ${JSON.stringify(issues)}`,
    );
  });

  test('refuses to publish one, and lists every problem at once', async () => {
    const { id } = await createExpedition(api, unfinishedDocument());

    const answer = await api.request(
      `/expeditions/${id}/publish`,
      as(token(ORG_A), { method: 'POST' }),
    );

    assert.equal(answer.status, 422);
    assert.equal(answer.body['error'], 'validation-failed');
    assert.ok((answer.body['details'] as unknown[]).length > 0);
  });
});

describe('publishing freezes a revision', () => {
  test('freezes revision 1 and stamps it', async () => {
    const { id } = await createExpedition(api);

    const published = await api.request(
      `/expeditions/${id}/publish`,
      as(token(ORG_A), { method: 'POST' }),
    );

    assert.equal(published.status, 200);
    assert.equal(versionIn(published.body)['status'], 'published');
    assert.equal(versionIn(published.body)['definitionVersion'], 1);
    assert.ok(versionIn(published.body)['publishedAt'] !== null);
    // The stored document says the same as the row it is stored in.
    assert.equal(documentIn(published.body)['status'], 'published');
    assert.equal(
      documentIn(published.body)['publishedAt'],
      versionIn(published.body)['publishedAt'],
    );
  });

  test('refuses a second publish, because there is nothing to publish', async () => {
    const { id } = await createExpedition(api);
    await api.request(`/expeditions/${id}/publish`, as(token(ORG_A), { method: 'POST' }));

    const again = await api.request(
      `/expeditions/${id}/publish`,
      as(token(ORG_A), { method: 'POST' }),
    );

    assert.equal(again.status, 409);
    assert.equal(again.body['error'], 'conflict');
  });

  test('a change after publishing starts revision 2 and leaves revision 1 alone', async () => {
    const { id } = await createExpedition(api);
    const first = await api.request(
      `/expeditions/${id}/publish`,
      as(token(ORG_A), { method: 'POST' }),
    );
    const frozenAt = versionIn(first.body)['publishedAt'];

    const renamed = documentFor();
    (renamed['metadata'] as Record<string, unknown>)['title'] = 'A walk round the park';
    const saved = await api.request(
      `/expeditions/${id}/draft`,
      as(token(ORG_A), { method: 'PUT', body: { definition: renamed } }),
    );

    assert.equal(saved.status, 200);
    assert.equal(versionIn(saved.body)['definitionVersion'], 2);
    assert.equal(versionIn(saved.body)['status'], 'draft');

    const revision1 = await api.request(
      `/expeditions/${id}/versions/1`,
      as(token(ORG_A)),
    );
    assert.equal(versionIn(revision1.body)['status'], 'published');
    assert.equal(versionIn(revision1.body)['publishedAt'], frozenAt);
    assert.equal(versionIn(revision1.body)['title'], 'A walk round the museum');
  });

  test('a second save writes over the same draft rather than making a third', async () => {
    const { id } = await createExpedition(api);

    for (const title of ['One', 'Two', 'Three']) {
      const document = documentFor();
      (document['metadata'] as Record<string, unknown>)['title'] = title;
      await api.request(
        `/expeditions/${id}/draft`,
        as(token(ORG_A), { method: 'PUT', body: { definition: document } }),
      );
    }

    const versions = await api.request(`/expeditions/${id}/versions`, as(token(ORG_A)));
    assert.equal((versions.body['versions'] as unknown[]).length, 1);

    const draft = await api.request(`/expeditions/${id}/draft`, as(token(ORG_A)));
    assert.equal(versionIn(draft.body)['title'], 'Three');
    assert.equal(versionIn(draft.body)['definitionVersion'], 1);
  });
});

describe('reading one', () => {
  test('carries the draft and the published revision side by side', async () => {
    const { id } = await createExpedition(api);
    await api.request(`/expeditions/${id}/publish`, as(token(ORG_A), { method: 'POST' }));
    await api.request(
      `/expeditions/${id}/draft`,
      as(token(ORG_A), { method: 'PUT', body: { definition: documentFor() } }),
    );

    const answer = await api.request(`/expeditions/${id}`, as(token(ORG_A)));

    assert.equal(answer.status, 200);
    assert.equal(answer.body['status'], 'published');
    assert.equal((answer.body['draft'] as Record<string, unknown>)['definitionVersion'], 2);
    assert.equal(
      (answer.body['published'] as Record<string, unknown>)['definitionVersion'],
      1,
    );
    assert.equal(answer.body['versionCount'], 2);
  });

  test('has no draft to read while the newest revision is frozen', async () => {
    const { id } = await createExpedition(api);
    await api.request(`/expeditions/${id}/publish`, as(token(ORG_A), { method: 'POST' }));

    const answer = await api.request(`/expeditions/${id}/draft`, as(token(ORG_A)));

    assert.equal(answer.status, 404);
    assert.equal(answer.body['error'], 'not-found');
  });

  test('an id that is not an id is turned away before anything is read', async () => {
    const answer = await api.request('/expeditions/not-an-id', as(token(ORG_A)));

    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body['details'], [
      { path: ':id', message: 'This has to be an id.' },
    ]);
  });

  test('an expedition nobody has is not found', async () => {
    const answer = await api.request(
      '/expeditions/99999999-9999-4999-8999-999999999999',
      as(token(ORG_A)),
    );

    assert.equal(answer.status, 404);
  });
});

describe('listing them', () => {
  test('answers a page with the total, and filters by status', async () => {
    const own = await harness();
    try {
      const { id } = await createExpedition(own);
      await createExpedition(own);
      await own.request(`/expeditions/${id}/publish`, as(token(ORG_A), { method: 'POST' }));

      const all = await own.request('/expeditions', as(token(ORG_A)));
      assert.equal(all.status, 200);
      assert.equal(all.body['total'], 2);
      assert.equal((all.body['expeditions'] as unknown[]).length, 2);

      const drafts = await own.request('/expeditions?status=draft', as(token(ORG_A)));
      assert.equal(drafts.body['total'], 1);

      const published = await own.request(
        '/expeditions?status=published',
        as(token(ORG_A)),
      );
      assert.equal(published.body['total'], 1);
      assert.equal(
        (published.body['expeditions'] as Record<string, unknown>[])[0]?.['id'],
        id,
      );
    } finally {
      await own.close();
    }
  });

  test('refuses a limit that is not a number, rather than ignoring it', async () => {
    const answer = await api.request('/expeditions?limit=all', as(token(ORG_A)));

    assert.equal(answer.status, 422);
    assert.deepEqual(answer.body['details'], [
      { path: '?limit', message: 'This has to be a whole number.' },
    ]);
  });
});
