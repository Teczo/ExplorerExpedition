/**
 * The timed challenge mission type (EXPD-036).
 *
 * A task against the clock: get the whole team to the bandstand and back,
 * sort the leaf pile by tree, find the finish post. The app shows the steps
 * and runs the clock; the team stops it when they are done. **How long they
 * took is what they score.**
 *
 * **The clock is the server's.** It starts when the team opens the mission —
 * the `start` in the mission's own history — and stops when the submission
 * reaches the API. The engine measures that and hands it in as
 * `elapsedSeconds` (EXPD-011's input, widened for this type). Nothing the
 * phone says about time is read, so a phone with its clock wound back gains
 * nothing.
 *
 * **Time becomes a share of the points.** Inside `fullPointsWithinSeconds`
 * the team earns all of them. After that the share falls in a straight line
 * until `pointsRunOutAtSeconds`, where it reaches `minimumShare` (nought
 * unless the author says) and stays. The share goes out as the verdict's
 * `progress`, and the scoring engine (EXPD-012) pays `basePoints` times it —
 * which it does only when the mission allows partial credit. That is why
 * this type's Studio default turns partial credit on.
 *
 * **Finishing late is still finishing.** A slow team completes the mission
 * and earns less; it is not turned away. A mission that should *end* when
 * the time is up sets the mission's own `timeLimitSeconds` (EXPD-002), and the
 * engine expires it (EXPD-011).
 *
 * **Proof is optional.** An author may put a `finishCode` at the finish — on
 * a card, a sign, a teacher's lips — and the team has to send it to stop the
 * clock. Without one the team's word is taken. A teacher review is not
 * offered: a teacher's approval pays full points whenever it is given, which
 * would undo what this type is for.
 *
 * **What the schema cannot say.** The schema subset cannot compare two
 * fields (EXPD-009), so a `pointsRunOutAtSeconds` at or below
 * `fullPointsWithinSeconds` is read as a cliff: full points inside the time,
 * `minimumShare` after it. A rule of this file, not a refusal.
 *
 * Pure, like every behaviour: the time comes in, nothing reads a clock.
 */

import {
  defineMissionType,
  type MissionEvaluation,
  type MissionTypeEntry,
} from '@explorer/engine';
import type { JsonObject, MissionTypeAuthoring } from '@explorer/shared-types';

/** The key an expedition pins to. */
export const TIMED_CHALLENGE_KEY = 'timed-challenge';

/** The version this file judges. */
export const TIMED_CHALLENGE_VERSION = '1.0.0';

/** The most steps one challenge may list. */
export const MAX_TIMED_STEPS = 20;

/** The longest one step may be. */
export const MAX_TIMED_STEP_LENGTH = 200;

/** The longest finish code an author may set, or a team may send. */
export const MAX_FINISH_CODE_LENGTH = 40;

/** Something besides spaces. The platform anchors a pattern (EXPD-009). */
const NOT_BLANK = '\\s*\\S[\\s\\S]*';

/** What `prepare` makes of a config, once per mission. */
export interface PreparedTimedChallenge {
  readonly fullPointsWithinSeconds: number;
  readonly pointsRunOutAtSeconds: number;
  /** The share a finish earns however slow it was, from 0 to 1. */
  readonly minimumShare: number;
  /** The finish code in the form it is compared in, or `undefined` when there is none. */
  readonly finishCode: string | undefined;
}

/** The form a finish code is compared in: no spaces, any case. */
export function finishCodeKey(code: string): string {
  return code.replace(/\s+/g, '').toLowerCase();
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Turns an author's config into what a challenge is judged with. */
export function prepareTimedChallenge(config: JsonObject): PreparedTimedChallenge {
  const full = positive(config['fullPointsWithinSeconds'], 60);
  const share = config['minimumShare'];
  const code = config['finishCode'];
  const key = typeof code === 'string' ? finishCodeKey(code) : '';
  return {
    fullPointsWithinSeconds: full,
    pointsRunOutAtSeconds: positive(config['pointsRunOutAtSeconds'], full),
    minimumShare:
      typeof share === 'number' && Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0,
    finishCode: key === '' ? undefined : key,
  };
}

/**
 * The share of the points a finish after `elapsedSeconds` earns, from 0 to 1.
 *
 * All of them inside the full-points time, `minimumShare` from the run-out
 * time on, and a straight line between the two.
 */
export function timedShare(challenge: PreparedTimedChallenge, elapsedSeconds: number): number {
  const { fullPointsWithinSeconds: full, pointsRunOutAtSeconds: out, minimumShare } = challenge;
  if (elapsedSeconds <= full) {
    return 1;
  }
  if (out <= full || elapsedSeconds >= out) {
    return minimumShare;
  }
  const through = (elapsedSeconds - full) / (out - full);
  return 1 - (1 - minimumShare) * through;
}

/** A number of seconds as the team reads it: "0:45", "2:05", "1:02:30". */
export function clockTime(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, '0');
  return hours > 0
    ? `${String(hours)}:${String(minutes).padStart(2, '0')}:${rest}`
    : `${String(minutes)}:${rest}`;
}

/** The timed challenge type: its definition, and the code that judges one. */
export const timedChallenge: MissionTypeEntry = defineMissionType({
  definition: {
    key: TIMED_CHALLENGE_KEY,
    version: TIMED_CHALLENGE_VERSION,
    name: 'Timed challenge',
    description:
      'Teams race the clock to finish a task. The faster they finish, the more points they earn.',
    status: 'published',
    capabilities: [],
    configSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_TIMED_STEPS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_TIMED_STEP_LENGTH,
            pattern: NOT_BLANK,
          },
        },
        fullPointsWithinSeconds: { type: 'integer', minimum: 1 },
        pointsRunOutAtSeconds: { type: 'integer', minimum: 1 },
        minimumShare: { type: 'number', minimum: 0, maximum: 1 },
        finishCode: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_FINISH_CODE_LENGTH,
          pattern: NOT_BLANK,
        },
      },
      required: ['steps', 'fullPointsWithinSeconds', 'pointsRunOutAtSeconds'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        done: { type: 'boolean', const: true },
        code: { type: 'string', maxLength: MAX_FINISH_CODE_LENGTH },
      },
      required: ['done'],
    },
    defaultConfig: {
      steps: ['Say what the team has to do before the clock stops.'],
      fullPointsWithinSeconds: 60,
      pointsRunOutAtSeconds: 180,
      minimumShare: 0,
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedTimedChallenge {
      return prepareTimedChallenge(config);
    },
    evaluate({ config, prepared, submission, elapsedSeconds }): MissionEvaluation {
      const challenge =
        (prepared as PreparedTimedChallenge | undefined) ?? prepareTimedChallenge(config);

      if (challenge.finishCode !== undefined) {
        const sent = submission['code'];
        if (typeof sent !== 'string' || finishCodeKey(sent) !== challenge.finishCode) {
          return {
            outcome: 'incorrect',
            progress: 0,
            feedback:
              typeof sent === 'string' && sent.trim() !== ''
                ? 'That is not the finish code. The clock is still running.'
                : 'Enter the code from the finish to stop the clock.',
          };
        }
      }

      if (elapsedSeconds === undefined || !Number.isFinite(elapsedSeconds)) {
        // Without a start there is nothing to time, and guessing a time would
        // be guessing a score. A person decides instead.
        return {
          outcome: 'needs-review',
          feedback: 'Handed in. Your teacher will check it.',
          detail: { elapsedSeconds: null },
        };
      }

      const share = timedShare(challenge, elapsedSeconds);
      const time = clockTime(elapsedSeconds);
      const full = clockTime(challenge.fullPointsWithinSeconds);
      const feedback =
        share >= 1
          ? `Done in ${time}, inside ${full}: full points.`
          : `Done in ${time}. Full points were inside ${full}; ` +
            `this finish earns ${String(Math.round(share * 100))}% of them.`;

      return {
        outcome: 'correct',
        progress: share,
        feedback,
        detail: {
          elapsedSeconds,
          fullPointsWithinSeconds: challenge.fullPointsWithinSeconds,
          pointsRunOutAtSeconds: challenge.pointsRunOutAtSeconds,
          share,
        },
      };
    },
  },
});

/**
 * What the Studio shows a new timed challenge starting with (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0013 has
 * one source to be checked against. Partial credit is on, because the share
 * of the points this type works out is paid only when it is; `automatic`
 * because a teacher's approval would pay full points at any speed. The team
 * is shown the steps and the full-points time, and never the finish code.
 */
export const TIMED_CHALLENGE_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: true },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'config-field', field: 'steps', heading: 'What to do' },
      {
        kind: 'config-field',
        field: 'fullPointsWithinSeconds',
        heading: 'Full points inside (seconds)',
      },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'Stop the clock',
  },
};
