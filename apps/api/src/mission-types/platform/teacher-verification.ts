/**
 * The teacher verification mission type (EXPD-037).
 *
 * A task only a person can sign off: perform the poem, show the knot, explain
 * the map to the teacher at the gate. The team does it in front of the
 * facilitator and says they are ready; the facilitator approves it or sends
 * it back from Director Mode.
 *
 * **Code never decides.** Every hand-in answers `needs-review`, so the
 * mission waits in `awaiting-verification` and nothing is scored. The
 * facilitator's decision is EXPD-020's endpoint —
 * `POST /sessions/:id/teams/:teamId/missions/:missionId/complete` with
 * `approve` or `reject` and an optional note — which Director Mode (EXPD-055)
 * and its review queue (EXPD-056) call. Approving completes the mission and
 * pays for it; rejecting hands it back for another go, or fails it on the
 * last try, as the state machine says (EXPD-010).
 *
 * **`checklist` is for the team and for the facilitator.** It lists what the
 * facilitator is looking for. The student layout shows it to the team, and
 * the verdict's `detail` carries it with the team's note, so whoever decides
 * reads the same list the team was given.
 *
 * Pure, like every behaviour: no clock, no network, nothing kept between
 * calls.
 */

import {
  defineMissionType,
  type MissionEvaluation,
  type MissionTypeEntry,
} from '@explorer/engine';
import type { JsonObject, MissionTypeAuthoring } from '@explorer/shared-types';

/** The key an expedition pins to. */
export const TEACHER_VERIFICATION_KEY = 'teacher-verification';

/** The version this file judges. */
export const TEACHER_VERIFICATION_VERSION = '1.0.0';

/** The most things a facilitator may be asked to check. */
export const MAX_CHECKLIST_ITEMS = 10;

/** The longest one of those may be. */
export const MAX_CHECKLIST_ITEM_LENGTH = 200;

/** The longest note a team may send with the hand-in. */
export const MAX_VERIFICATION_NOTE_LENGTH = 280;

/** Something besides spaces. The platform anchors a pattern (EXPD-009). */
const NOT_BLANK = '\\s*\\S[\\s\\S]*';

/** What `prepare` makes of a config, once per mission. */
export interface PreparedTeacherVerification {
  /** What the facilitator checks, blank lines taken out. */
  readonly checklist: readonly string[];
}

/** Turns an author's config into what a hand-in is referred with. */
export function prepareTeacherVerification(config: JsonObject): PreparedTeacherVerification {
  const raw = Array.isArray(config['checklist']) ? config['checklist'] : [];
  return {
    checklist: raw
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
  };
}

/** The teacher verification type: its definition, and the code that refers it. */
export const teacherVerification: MissionTypeEntry = defineMissionType({
  definition: {
    key: TEACHER_VERIFICATION_KEY,
    version: TEACHER_VERIFICATION_VERSION,
    name: 'Teacher verification',
    description:
      'Teams show a facilitator what they did, and the facilitator approves or rejects it.',
    status: 'published',
    capabilities: [],
    configSchema: {
      type: 'object',
      properties: {
        checklist: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CHECKLIST_ITEMS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_CHECKLIST_ITEM_LENGTH,
            pattern: NOT_BLANK,
          },
        },
      },
      required: ['checklist'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        ready: { type: 'boolean', const: true },
        note: { type: 'string', maxLength: MAX_VERIFICATION_NOTE_LENGTH },
      },
      required: ['ready'],
    },
    defaultConfig: {
      checklist: ['Say what the facilitator has to see.'],
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedTeacherVerification {
      return prepareTeacherVerification(config);
    },
    evaluate({ config, prepared, submission }): MissionEvaluation {
      const verification =
        (prepared as PreparedTeacherVerification | undefined) ??
        prepareTeacherVerification(config);
      const note = submission['note'];
      return {
        outcome: 'needs-review',
        feedback: 'Ready. Your teacher will check it and approve it or send it back.',
        detail: {
          checklist: [...verification.checklist],
          ...(typeof note === 'string' && note.trim() !== '' ? { note } : {}),
        },
      };
    },
  },
});

/**
 * What the Studio shows a new teacher verification mission starting with
 * (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0014 has
 * one source to be checked against. `automatic` rather than `teacher`, the
 * same choice photo evidence makes: either way a facilitator decides, but
 * `teacher` skips this type's code, and with it the checklist and the team's
 * note in the verdict's `detail` the facilitator reads.
 */
export const TEACHER_VERIFICATION_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: false },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'config-field', field: 'checklist', heading: 'Your teacher will check' },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'Ready for the teacher',
  },
};
