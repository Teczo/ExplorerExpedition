/**
 * The physical challenge mission type (EXPD-034).
 *
 * A task the team does with their hands and bodies, out in the world: build a
 * bridge from sticks, run to the oak and back, tie a bowline. The app
 * describes it; the team does it and says so. This file judges that.
 *
 * The author picks what kind of task it is with `activity` — `build`, `move`
 * or `skill` — so the student app can show it the right way, writes the
 * `steps` the team follows, and may write what `doneWhen` means.
 *
 * **A measured target is the one thing code can check.** An author may give
 * the challenge a `measure` — the tower's height in cm, star jumps in a
 * minute, seconds to run the loop — with `atLeast`, `atMost` or both. The
 * team then hands in its `result`, and a result outside the target is turned
 * away with what the target is. The team has to be told the target to aim
 * for it, so feedback naming it gives nothing away.
 *
 * **Everything else is a person's to judge.** By default a challenge the team
 * says is done goes to a teacher (`needs-review`), as photo evidence does
 * (EXPD-033). An author who trusts the team — a warm-up, a game where the
 * teacher is watching anyway — sets `acceptWithoutReview` and it counts at
 * once. A result that misses the target is turned away either way; nobody
 * needs to look at that.
 *
 * **What the schema cannot say.** The config schema subset has no
 * conditionals and cannot compare two fields (EXPD-009). So a `result` is
 * asked for only when there is a `measure`, and is ignored for the verdict
 * when there is not; and an `atLeast` above `atMost` is read as the range
 * between them. Both are rules of this file, not refusals.
 *
 * Pure, like every behaviour: no clock, no network, nothing kept between
 * calls.
 */

import { defineMissionType, type MissionTypeEntry } from '@explorer/engine';
import type { JsonObject, MissionTypeAuthoring } from '@explorer/shared-types';

/** The key an expedition pins to. */
export const PHYSICAL_CHALLENGE_KEY = 'physical-challenge';

/** The version this file judges. */
export const PHYSICAL_CHALLENGE_VERSION = '1.0.0';

/** What kind of task a physical challenge is. */
export type PhysicalActivity = 'build' | 'move' | 'skill';

/** Every activity, in the order the Studio offers them. */
export const PHYSICAL_ACTIVITIES = [
  'build',
  'move',
  'skill',
] as const satisfies readonly PhysicalActivity[];

/** The most steps one challenge may list. */
export const MAX_CHALLENGE_STEPS = 20;

/** The most things an author may say "done" means. */
export const MAX_DONE_WHEN = 10;

/** The longest one step, or one "done when", may be. */
export const MAX_CHALLENGE_LINE_LENGTH = 200;

/** The longest name a measure may have, such as "Tower height". */
export const MAX_MEASURE_NAME_LENGTH = 80;

/** The longest unit a measure may have, such as "cm". */
export const MAX_MEASURE_UNIT_LENGTH = 20;

/** The longest note a team may send with the challenge. */
export const MAX_CHALLENGE_NOTE_LENGTH = 280;

/** Something besides spaces. The platform anchors a pattern (EXPD-009). */
const NOT_BLANK = '\\s*\\S[\\s\\S]*';

/** What the team measures, and the target the result has to meet. */
export interface ChallengeMeasure {
  readonly what: string;
  readonly unit: string;
  readonly atLeast?: number;
  readonly atMost?: number;
}

/** What `prepare` makes of a config, once per mission. */
export interface PreparedPhysicalChallenge {
  readonly activity: PhysicalActivity;
  /** What "done" means, blank lines taken out. */
  readonly doneWhen: readonly string[];
  /** What is measured, or `undefined` when nothing is. */
  readonly measure: ChallengeMeasure | undefined;
  /** Whether a challenge the team says is done counts without a person looking. */
  readonly acceptWithoutReview: boolean;
}

function isActivity(value: unknown): value is PhysicalActivity {
  return typeof value === 'string' && (PHYSICAL_ACTIVITIES as readonly string[]).includes(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function prepareMeasure(value: unknown): ChallengeMeasure | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as JsonObject;
  const what = raw['what'];
  const unit = raw['unit'];
  if (typeof what !== 'string' || typeof unit !== 'string') {
    return undefined;
  }
  let atLeast = finite(raw['atLeast']);
  let atMost = finite(raw['atMost']);
  if (atLeast !== undefined && atMost !== undefined && atLeast > atMost) {
    // The schema cannot compare two fields. Read it as the range between them.
    [atLeast, atMost] = [atMost, atLeast];
  }
  return {
    what: what.trim(),
    unit: unit.trim(),
    ...(atLeast === undefined ? {} : { atLeast }),
    ...(atMost === undefined ? {} : { atMost }),
  };
}

/** Turns an author's config into what a challenge is judged with. */
export function preparePhysicalChallenge(config: JsonObject): PreparedPhysicalChallenge {
  const raw = Array.isArray(config['doneWhen']) ? config['doneWhen'] : [];
  const doneWhen = raw
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item !== '');
  return {
    activity: isActivity(config['activity']) ? config['activity'] : 'move',
    doneWhen,
    measure: prepareMeasure(config['measure']),
    acceptWithoutReview: config['acceptWithoutReview'] === true,
  };
}

/** The target, in words: "at least 50 cm", "between 40 and 60 seconds". */
export function describeTarget(measure: ChallengeMeasure): string | undefined {
  const { atLeast, atMost, unit } = measure;
  if (atLeast !== undefined && atMost !== undefined) {
    return atLeast === atMost ? `exactly ${atLeast} ${unit}` : `between ${atLeast} and ${atMost} ${unit}`;
  }
  if (atLeast !== undefined) {
    return `at least ${atLeast} ${unit}`;
  }
  if (atMost !== undefined) {
    return `at most ${atMost} ${unit}`;
  }
  return undefined;
}

function meetsTarget(measure: ChallengeMeasure, result: number): boolean {
  return (
    (measure.atLeast === undefined || result >= measure.atLeast) &&
    (measure.atMost === undefined || result <= measure.atMost)
  );
}

/**
 * How close a missed result came, from 0 to 1.
 *
 * Only a target with a floor and no ceiling can be partly met: 15 of at
 * least 20 star jumps is three quarters of the way. Over a ceiling, or
 * outside a range, there is no "partly".
 */
function progressTowards(measure: ChallengeMeasure, result: number): number {
  if (measure.atMost !== undefined || measure.atLeast === undefined || measure.atLeast <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(1, result / measure.atLeast));
}

/** The physical challenge type: its definition, and the code that judges one. */
export const physicalChallenge: MissionTypeEntry = defineMissionType({
  definition: {
    key: PHYSICAL_CHALLENGE_KEY,
    version: PHYSICAL_CHALLENGE_VERSION,
    name: 'Physical challenge',
    description:
      'Teams build something, move, or show a skill in the real world, following steps the app describes.',
    status: 'published',
    capabilities: [],
    configSchema: {
      type: 'object',
      properties: {
        activity: { type: 'string', enum: [...PHYSICAL_ACTIVITIES] },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_CHALLENGE_STEPS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_CHALLENGE_LINE_LENGTH,
            pattern: NOT_BLANK,
          },
        },
        doneWhen: {
          type: 'array',
          maxItems: MAX_DONE_WHEN,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_CHALLENGE_LINE_LENGTH,
            pattern: NOT_BLANK,
          },
        },
        measure: {
          type: 'object',
          properties: {
            what: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_MEASURE_NAME_LENGTH,
              pattern: NOT_BLANK,
            },
            unit: {
              type: 'string',
              minLength: 1,
              maxLength: MAX_MEASURE_UNIT_LENGTH,
              pattern: NOT_BLANK,
            },
            atLeast: { type: 'number' },
            atMost: { type: 'number' },
          },
          required: ['what', 'unit'],
        },
        acceptWithoutReview: { type: 'boolean' },
      },
      required: ['activity', 'steps'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        done: { type: 'boolean', const: true },
        result: { type: 'number' },
        note: { type: 'string', maxLength: MAX_CHALLENGE_NOTE_LENGTH },
      },
      required: ['done'],
    },
    defaultConfig: {
      activity: 'move',
      steps: ['Say what the team has to do.'],
      doneWhen: ['Say how the team knows they are done.'],
      acceptWithoutReview: false,
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedPhysicalChallenge {
      return preparePhysicalChallenge(config);
    },
    evaluate({ config, prepared, submission }) {
      const challenge =
        (prepared as PreparedPhysicalChallenge | undefined) ?? preparePhysicalChallenge(config);
      const result = finite(submission['result']);
      const note = submission['note'];
      const { measure } = challenge;

      const detail: JsonObject = {
        activity: challenge.activity,
        doneWhen: [...challenge.doneWhen],
        ...(measure === undefined
          ? {}
          : { measure: measure.what, unit: measure.unit, result: result ?? null }),
        ...(typeof note === 'string' && note.trim() !== '' ? { note } : {}),
      };

      if (measure !== undefined) {
        if (result === undefined) {
          return {
            outcome: 'incorrect',
            progress: 0,
            feedback: `Enter your ${measure.what.toLowerCase()} in ${measure.unit}, then hand it in.`,
            detail,
          };
        }
        if (!meetsTarget(measure, result)) {
          return {
            outcome: 'incorrect',
            progress: progressTowards(measure, result),
            feedback: `Not yet: ${result} ${measure.unit}. ${measure.what} has to be ${describeTarget(measure)}.`,
            detail,
          };
        }
      }

      if (challenge.acceptWithoutReview) {
        return { outcome: 'correct', progress: 1, feedback: 'Challenge complete.', detail };
      }
      return {
        outcome: 'needs-review',
        feedback: 'Challenge handed in. Your teacher will check it.',
        detail,
      };
    },
  },
});

/**
 * What the Studio shows a new physical challenge starting with (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0011 has
 * one source to be checked against. `automatic` because this type's own code
 * checks the target and sends the rest to a teacher; `teacher` would skip the
 * code, and with it the target and `acceptWithoutReview`.
 */
export const PHYSICAL_CHALLENGE_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: false },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'config-field', field: 'steps', heading: 'What to do' },
      { kind: 'config-field', field: 'doneWhen', heading: 'You are done when' },
      { kind: 'config-field', field: 'measure', heading: 'What to measure' },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'We did it',
  },
};
