/**
 * What the platform writes into a document, and what it refuses (EXPD-017).
 *
 * `seal` is the only way a document reaches a row, so anything it gets wrong
 * is wrong in storage rather than only in a response. The six fields it owns
 * are tested here one by one, away from HTTP, because each of them is a
 * separate promise: the id is the row's, the revision number is the
 * platform's counter, the status is what the API did rather than what a
 * client asked for, and the authoring block says who really saved it.
 *
 * `expeditionDocument` is the other half: the little that has to be true of a
 * document before it is stored at all. It is deliberately much less than the
 * schema asks for — a draft is allowed to be halfway through — so the tests
 * about what it lets *through* matter as much as the ones about what it
 * turns away.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EXPEDITION_SCHEMA_VERSION, type JsonObject } from '@explorer/shared-types';

import {
  expeditionDocument,
  issuesInDocument,
  MAX_TITLE_LENGTH,
  schemaVersionOf,
  seal,
  summaryOf,
  type DocumentSeal,
} from '../../src/expeditions/documents.ts';
import { documentFor } from './support.ts';

const SEAL: DocumentSeal = {
  expeditionId: '11111111-1111-4111-8111-111111111111',
  definitionVersion: 3,
  status: 'draft',
  organisationId: '22222222-2222-4222-8222-222222222222',
  createdBy: '33333333-3333-4333-8333-333333333333',
  createdAt: new Date('2026-01-01T09:00:00.000Z'),
  updatedBy: '44444444-4444-4444-8444-444444444444',
  updatedAt: new Date('2026-02-02T10:00:00.000Z'),
  source: 'creator-web',
};

/** The authoring block of a sealed document. */
function authoringIn(document: JsonObject): Record<string, unknown> {
  return (document['metadata'] as Record<string, unknown>)['authoring'] as Record<
    string,
    unknown
  >;
}

/** What a checker says about a value, as plain paths. */
function checkPaths(value: unknown): readonly string[] {
  const result = expeditionDocument().check(value, 'definition');
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

describe('sealing a document', () => {
  test('writes the platform’s six fields over whatever was sent', () => {
    const sealed = seal(documentFor(), SEAL);

    assert.equal(sealed['id'], SEAL.expeditionId);
    assert.equal(sealed['definitionVersion'], 3);
    assert.equal(sealed['status'], 'draft');
    assert.equal(authoringIn(sealed)['organisationId'], SEAL.organisationId);
    assert.equal(authoringIn(sealed)['createdBy'], SEAL.createdBy);
    assert.equal(authoringIn(sealed)['createdAt'], '2026-01-01T09:00:00.000Z');
    assert.equal(authoringIn(sealed)['updatedBy'], SEAL.updatedBy);
    assert.equal(authoringIn(sealed)['updatedAt'], '2026-02-02T10:00:00.000Z');
    assert.equal(authoringIn(sealed)['source'], 'creator-web');
  });

  test('leaves the author’s own fields alone', () => {
    const sealed = seal(documentFor(), SEAL);
    const metadata = sealed['metadata'] as Record<string, unknown>;

    assert.equal(metadata['title'], 'A walk round the museum');
    assert.equal(metadata['setting'], 'indoor');
    assert.deepEqual(sealed['graph'], documentFor()['graph']);
  });

  test('does not change the document it was given', () => {
    const original = documentFor();
    seal(original, SEAL);

    assert.equal(original['id'], 'whatever-the-client-called-it');
    assert.equal(original['definitionVersion'], 99);
  });

  test('takes the published time off a draft, and puts it on a published one', () => {
    const asDraft = seal(documentFor(), SEAL);
    assert.equal('publishedAt' in asDraft, false);

    const asPublished = seal(documentFor(), {
      ...SEAL,
      status: 'published',
      publishedAt: new Date('2026-03-03T11:00:00.000Z'),
    });
    assert.equal(asPublished['publishedAt'], '2026-03-03T11:00:00.000Z');
    assert.equal(asPublished['status'], 'published');
  });

  test('leaves a sealed document valid', () => {
    const sealed = seal(documentFor(), SEAL);

    assert.deepEqual(issuesInDocument(sealed, 'definition'), []);
  });

  test('builds an authoring block for a document that had none', () => {
    const bare: JsonObject = { metadata: { title: 'Half an idea' } };

    const sealed = seal(bare, SEAL);

    assert.equal(authoringIn(sealed)['organisationId'], SEAL.organisationId);
    assert.equal((sealed['metadata'] as Record<string, unknown>)['title'], 'Half an idea');
  });
});

describe('the schema version a document is stored under', () => {
  test('is the one it names, when this build can read it', () => {
    assert.equal(schemaVersionOf({ schemaVersion: '1.0.0' }), '1.0.0');
  });

  test('is this build’s own when the document names none', () => {
    assert.equal(schemaVersionOf({}), EXPEDITION_SCHEMA_VERSION);
  });
});

describe('the copied columns', () => {
  test('come off the metadata, trimmed', () => {
    assert.deepEqual(
      summaryOf({ metadata: { title: '  A walk  ', summary: ' Short. ', locale: 'cy' } }),
      { title: 'A walk', summary: 'Short.', locale: 'cy' },
    );
  });

  test('fall back the way the schema does', () => {
    assert.deepEqual(summaryOf({ metadata: { title: 'A walk' } }), {
      title: 'A walk',
      summary: '',
      locale: 'en-GB',
    });
  });
});

describe('what a document has to be before it is stored', () => {
  test('an unfinished one is let through', () => {
    assert.deepEqual(checkPaths({ metadata: { title: 'Half an idea' } }), []);
  });

  test('something that is not an object is not a document', () => {
    assert.deepEqual(checkPaths('a walk round the museum'), ['definition']);
    assert.deepEqual(checkPaths([]), ['definition']);
  });

  test('a document with no name is refused', () => {
    assert.deepEqual(checkPaths({ metadata: {} }), ['definition.metadata.title']);
    assert.deepEqual(checkPaths({ metadata: { title: '   ' } }), [
      'definition.metadata.title',
    ]);
  });

  test('a document with no metadata is refused', () => {
    assert.deepEqual(checkPaths({}), ['definition.metadata']);
  });

  test('a title longer than a title is refused', () => {
    assert.deepEqual(checkPaths({ metadata: { title: 'a'.repeat(MAX_TITLE_LENGTH + 1) } }), [
      'definition.metadata.title',
    ]);
  });

  test('a schema version this build cannot read is refused', () => {
    assert.deepEqual(
      checkPaths({ schemaVersion: '9.0.0', metadata: { title: 'From the future' } }),
      ['definition.schemaVersion'],
    );
    assert.deepEqual(
      checkPaths({ schemaVersion: 'one', metadata: { title: 'Not a version' } }),
      ['definition.schemaVersion'],
    );
  });

  test('reports everything wrong at once', () => {
    assert.deepEqual(
      checkPaths({ schemaVersion: '9.0.0', metadata: { title: '' } }),
      ['definition.schemaVersion', 'definition.metadata.title'],
    );
  });
});

describe('what the validator says, in the API’s words', () => {
  test('points at the field inside the body, not at the document’s root', () => {
    const issues = issuesInDocument({ metadata: { title: 'Half an idea' } }, 'definition');

    assert.ok(issues.length > 0);
    assert.ok(
      issues.every((issue) => issue.path.startsWith('definition')),
      `got ${JSON.stringify(issues.map((issue) => issue.path))}`,
    );
  });
});
