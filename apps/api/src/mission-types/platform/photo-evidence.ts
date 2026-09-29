/**
 * The photo evidence mission type (EXPD-033).
 *
 * A team takes a photo as proof they did the mission, and hands it in. The
 * phone uploads the file first, through a signed URL (EXPD-021), and then
 * submits the id of the `media_asset` row that upload wrote. This file judges
 * that submission.
 *
 * **A photo cannot be judged by code.** So, by default, this type answers
 * `needs-review` and the teacher decides (EXPD-020's decision endpoint, and
 * the review queue in EXPD-056). An author who only wants the team to have
 * taken a photo — a team picture at the finish — sets `acceptWithoutReview`
 * and the photo counts as soon as it arrives.
 *
 * **`mustShow` is for the team and for the teacher.** It lists what the photo
 * has to show. The student layout shows it to the team, and the verdict's
 * `detail` carries it, so whoever reviews the photo reads the same list.
 *
 * **What this file cannot check.** A behaviour is pure: no network, no
 * database. Whether the id names a real image this team uploaded is the
 * API's to check, in `play/evidence.ts`, before the submission is written.
 *
 * Pure, like every behaviour: no clock, no network, nothing kept between
 * calls.
 */

import { defineMissionType, type MissionTypeEntry } from '@explorer/engine';
import type { JsonObject, MissionTypeAuthoring } from '@explorer/shared-types';

/** The key an expedition pins to. */
export const PHOTO_EVIDENCE_KEY = 'photo-evidence';

/** The version this file judges. */
export const PHOTO_EVIDENCE_VERSION = '1.0.0';

/** The most things an author may say the photo has to show. */
export const MAX_PHOTO_REQUIREMENTS = 10;

/** The longest one of those may be. */
export const MAX_PHOTO_REQUIREMENT_LENGTH = 200;

/** The longest caption a team may send with the photo. */
export const MAX_PHOTO_CAPTION_LENGTH = 280;

/**
 * A `media_asset` id, as the schema subset can say it.
 *
 * The platform anchors a pattern at both ends (EXPD-009).
 */
export const MEDIA_ID_PATTERN =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/** What `prepare` makes of a config, once per mission. */
export interface PreparedPhotoEvidence {
  /** What the photo has to show, blank lines taken out. */
  readonly mustShow: readonly string[];
  /** Whether the photo counts without a person looking at it. */
  readonly acceptWithoutReview: boolean;
}

/** Turns an author's config into what a photo is judged with. */
export function preparePhotoEvidence(config: JsonObject): PreparedPhotoEvidence {
  const raw = Array.isArray(config['mustShow']) ? config['mustShow'] : [];
  const mustShow = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return {
    mustShow,
    acceptWithoutReview: config['acceptWithoutReview'] === true,
  };
}

/**
 * The media id a photo evidence submission names.
 *
 * `undefined` when the payload has none. The API reads this to check the
 * file before it writes the submission.
 */
export function photoEvidenceMediaId(submission: JsonObject): string | undefined {
  const id = submission['mediaId'];
  return typeof id === 'string' ? id : undefined;
}

/** The photo evidence type: its definition, and the code that judges a photo. */
export const photoEvidence: MissionTypeEntry = defineMissionType({
  definition: {
    key: PHOTO_EVIDENCE_KEY,
    version: PHOTO_EVIDENCE_VERSION,
    name: 'Photo evidence',
    description:
      'Teams take a photo as proof they completed the mission, and a teacher checks it.',
    status: 'published',
    capabilities: ['camera'],
    configSchema: {
      type: 'object',
      properties: {
        mustShow: {
          type: 'array',
          maxItems: MAX_PHOTO_REQUIREMENTS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_PHOTO_REQUIREMENT_LENGTH,
            // Something besides spaces. The platform anchors a pattern (EXPD-009).
            pattern: '\\s*\\S[\\s\\S]*',
          },
        },
        acceptWithoutReview: { type: 'boolean' },
      },
      required: [],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        mediaId: { type: 'string', pattern: MEDIA_ID_PATTERN },
        caption: { type: 'string', maxLength: MAX_PHOTO_CAPTION_LENGTH },
      },
      required: ['mediaId'],
    },
    defaultConfig: {
      mustShow: ['Your whole team'],
      acceptWithoutReview: false,
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedPhotoEvidence {
      return preparePhotoEvidence(config);
    },
    evaluate({ config, prepared, submission }) {
      const photo = (prepared as PreparedPhotoEvidence | undefined) ?? preparePhotoEvidence(config);
      const caption = submission['caption'];

      const detail: JsonObject = {
        mediaId: photoEvidenceMediaId(submission) ?? null,
        mustShow: [...photo.mustShow],
        ...(typeof caption === 'string' && caption.trim() !== '' ? { caption } : {}),
      };

      if (photo.acceptWithoutReview) {
        return { outcome: 'correct', progress: 1, feedback: 'Photo received.', detail };
      }
      return {
        outcome: 'needs-review',
        feedback: 'Photo received. Your teacher will check it.',
        detail,
      };
    },
  },
});

/**
 * What the Studio shows a new photo evidence mission starting with (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0010 has
 * one source to be checked against. `automatic` because this type's own code
 * sends the photo to a teacher; `teacher` would skip the code, and with it
 * `acceptWithoutReview`.
 */
export const PHOTO_EVIDENCE_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: false },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'config-field', field: 'mustShow', heading: 'Your photo has to show' },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'Send photo',
  },
};
