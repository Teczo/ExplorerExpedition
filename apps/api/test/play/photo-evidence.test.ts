/**
 * Photo evidence played through the API (EXPD-033).
 *
 * The fixture's `photo` mission is a `photo-evidence` mission. Here the API
 * plays it with the platform's code rather than the stand-in row, so the
 * photo a team names is checked, tied to the submission, and sent to a
 * teacher — or counted at once, when the author said no review is needed.
 */

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '@explorer/shared-types';

import type { FakeRow } from '../support/fake-database.ts';

import { photoEvidence } from '../../src/mission-types/platform/index.ts';
import {
  ASHA,
  BEN,
  CAL,
  ORG_A,
  ORG_B,
  RIA,
  TEAM_RED,
  codeMatch,
  harness,
  missionIn,
  phone,
  refusalOf,
  scoreOf,
  staff,
  type Harness,
} from './support.ts';

const PHOTO = 'a0000000-0000-4000-8000-000000000001';
const PHOTO_BY_BEN = 'a0000000-0000-4000-8000-000000000002';
const PHOTO_BY_CAL = 'a0000000-0000-4000-8000-000000000003';
const VIDEO = 'a0000000-0000-4000-8000-000000000004';
const FAILED = 'a0000000-0000-4000-8000-000000000005';
const THEIRS = 'b0000000-0000-4000-8000-000000000006';
const NOBODYS = 'a0000000-0000-4000-8000-000000000007';

function media(
  id: string,
  uploadedBy: string,
  options: { kind?: string; status?: string; organisationId?: string } = {},
): FakeRow {
  const organisationId = options.organisationId ?? ORG_A;
  return {
    id,
    organisation_id: organisationId,
    kind: options.kind ?? 'image',
    status: options.status ?? 'pending',
    storage_container: 'media',
    storage_path: `${organisationId}/${id}`,
    content_type: options.kind === 'video' ? 'video/mp4' : 'image/jpeg',
    uploaded_by: null,
    uploaded_by_participant: uploadedBy,
    submission_id: null,
    expedition_id: null,
    created_at: new Date(),
  };
}

async function photoHarness(photoConfig?: JsonObject): Promise<Harness> {
  const h = await harness({
    missionTypes: [codeMatch, photoEvidence],
    ...(photoConfig === undefined ? {} : { photoConfig }),
  });
  h.db.seed(
    'media_asset',
    media(PHOTO, ASHA),
    media(PHOTO_BY_BEN, BEN),
    media(PHOTO_BY_CAL, CAL),
    media(VIDEO, ASHA, { kind: 'video' }),
    media(FAILED, ASHA, { status: 'failed' }),
    media(THEIRS, RIA, { organisationId: ORG_B }),
    media(NOBODYS, ASHA, { status: 'deleted' }),
  );
  return h;
}

function mediaRow(h: Harness, id: string): FakeRow | undefined {
  return h.rows('media_asset').find((row) => row['id'] === id);
}

describe('a team hands in a photo', () => {
  test('it waits for a teacher, is tied to the submission, and scores nothing yet', async () => {
    const h = await photoHarness({ mustShow: ['The heron'] });
    try {
      await h.start(phone(ASHA), 'photo');
      const answer = await h.submit(phone(ASHA), 'photo', {
        payload: { mediaId: PHOTO, caption: 'By the pond.' },
      });

      assert.equal(answer.status, 201, JSON.stringify(answer.body));
      const verdict = answer.body['verdict'] as Record<string, unknown>;
      assert.equal(verdict['outcome'], 'needs-review');
      assert.equal(verdict['method'], 'behaviour');
      assert.equal(verdict['review'], 'required');
      assert.deepEqual(verdict['detail'], {
        mediaId: PHOTO,
        mustShow: ['The heron'],
        caption: 'By the pond.',
      });
      assert.equal(missionIn(answer)['state'], 'awaiting-verification');
      assert.deepEqual(scoreOf(answer).events, []);

      const submission = answer.body['submission'] as Record<string, unknown>;
      assert.equal(mediaRow(h, PHOTO)?.['submission_id'], submission['id']);
    } finally {
      await h.close();
    }
  });

  test('a teacher approving it finishes the mission and pays for it', async () => {
    const h = await photoHarness();
    try {
      await h.start(phone(ASHA), 'photo');
      await h.submit(phone(ASHA), 'photo', { payload: { mediaId: PHOTO } });
      const answer = await h.decide(staff(), TEAM_RED, 'photo', { decision: 'approve' });

      assert.equal(answer.status, 200);
      assert.equal(missionIn(answer)['state'], 'complete');
      assert.equal(scoreOf(answer).events[0]?.['points'], 20);
    } finally {
      await h.close();
    }
  });

  test('a photo a teammate took counts for the team', async () => {
    const h = await photoHarness();
    try {
      await h.start(phone(ASHA), 'photo');
      const answer = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: PHOTO_BY_BEN } });
      assert.equal(answer.status, 201, JSON.stringify(answer.body));
    } finally {
      await h.close();
    }
  });

  test('counts at once when the author said no review is needed', async () => {
    const h = await photoHarness({ acceptWithoutReview: true });
    try {
      await h.start(phone(ASHA), 'photo');
      const answer = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: PHOTO } });

      assert.equal(answer.status, 201, JSON.stringify(answer.body));
      assert.equal((answer.body['verdict'] as Record<string, unknown>)['outcome'], 'correct');
      assert.equal(missionIn(answer)['state'], 'complete');
      assert.equal(scoreOf(answer).events[0]?.['points'], 20);
    } finally {
      await h.close();
    }
  });
});

describe('a photo that cannot be this team’s evidence is refused, and nothing is written', () => {
  const refused: ReadonlyArray<readonly [string, string]> = [
    ['one another team took', PHOTO_BY_CAL],
    ['a video', VIDEO],
    ['an upload that failed', FAILED],
    ['a deleted file', NOBODYS],
    ['another school’s file', THEIRS],
    ['an id nothing has', 'a0000000-0000-4000-8000-000000000099'],
  ];

  for (const [what, id] of refused) {
    test(what, async () => {
      const h = await photoHarness();
      try {
        await h.start(phone(ASHA), 'photo');
        const answer = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: id } });

        assert.equal(answer.status, 409, JSON.stringify(answer.body));
        assert.equal(refusalOf(answer), 'invalid-evidence');
        assert.equal(h.rows('submission').length, 0);
        assert.ok(h.rows('media_asset').every((row) => row['submission_id'] === null));
      } finally {
        await h.close();
      }
    });
  }

  test('a photo already handed in', async () => {
    const h = await photoHarness();
    try {
      await h.start(phone(ASHA), 'photo');
      await h.submit(phone(ASHA), 'photo', { payload: { mediaId: PHOTO } });
      await h.decide(staff(), TEAM_RED, 'photo', { decision: 'reject' });
      await h.start(phone(ASHA), 'photo');
      const again = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: PHOTO } });

      assert.equal(again.status, 409, JSON.stringify(again.body));
      assert.equal(refusalOf(again), 'invalid-evidence');
      assert.equal(h.rows('submission').length, 1);
    } finally {
      await h.close();
    }
  });

  test('an id that is not an upload id is refused by the schema first', async () => {
    const h = await photoHarness();
    try {
      await h.start(phone(ASHA), 'photo');
      const answer = await h.submit(phone(ASHA), 'photo', { payload: { mediaId: 'img-1' } });
      assert.equal(answer.status, 409);
      assert.equal(refusalOf(answer), 'invalid-submission');
    } finally {
      await h.close();
    }
  });
});
