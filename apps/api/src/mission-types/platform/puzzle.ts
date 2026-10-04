/**
 * The puzzle mission type (EXPD-035).
 *
 * A logic, code, sequence or pattern challenge the team answers in the app:
 * the padlock code hidden in the poem, what comes next in 2, 6, 18, …, which
 * suspect is lying, the order the river's locks were built in. This file
 * judges the answer.
 *
 * The author says what kind of puzzle it is with `kind`, so the student app
 * can show it the right way, writes the `question`, and picks how it is
 * answered with `answerType`:
 *
 *   - **`text`** — the team types an answer. It is right when it matches one
 *     of `acceptedAnswers`. Spaces at either end never matter and runs of
 *     spaces count as one; case does not matter unless `caseSensitive`; and
 *     `ignoreSpaces` drops every space, for a code typed as `47 19`.
 *   - **`number`** — the team types a number. It is right when it is within
 *     `tolerance` (default 0) of one of `acceptedAnswers`, so `8`, `8.0` and
 *     `08` are one answer. Only plain decimals with a dot are numbers.
 *   - **`choice`** — the team picks from `choices`. It is right when the
 *     ones picked are exactly `correctChoices`, no more and no fewer.
 *   - **`order`** — the team puts `choices` in order. It is right when the
 *     order is exactly `correctOrder`. Feedback says how many are in the
 *     right place, and so does `progress`.
 *
 * **The answer lives in the config, and only `question` and `choices` are
 * shown.** The student layout places those two fields and nothing else, so
 * `acceptedAnswers`, `correctChoices` and `correctOrder` stay off the team's
 * screen (EXPD-025). The verdict's `detail` keeps what the team sent and
 * never the answer.
 *
 * **What the schema cannot say.** The config schema subset has no
 * conditionals and cannot compare two fields (EXPD-009). So these are rules
 * of this file, not refusals:
 *
 *   - Each `answerType` reads only its own fields and ignores the others.
 *   - A choice id listed twice is one choice; the first one listed is kept.
 *     An id in `correctChoices` or `correctOrder` that is not a choice is
 *     ignored.
 *   - `order` with no `correctOrder` takes the choices in the order they
 *     are written, which is why the student app has to shuffle them.
 *   - A puzzle left with no answer at all — no usable `acceptedAnswers`, no
 *     known `correctChoices` — cannot be judged by code, so every answer to it
 *     goes to a teacher (`needs-review`) rather than being turned away.
 *
 * Pure, like every behaviour: no clock, no network, nothing kept between
 * calls.
 */

import { defineMissionType, type MissionTypeEntry } from '@explorer/engine';
import type { JsonObject, MissionTypeAuthoring } from '@explorer/shared-types';

/** The key an expedition pins to. */
export const PUZZLE_KEY = 'puzzle';

/** The version this file judges. */
export const PUZZLE_VERSION = '1.0.0';

/** What kind of puzzle it is. */
export type PuzzleKind = 'logic' | 'code' | 'sequence' | 'pattern';

/** Every kind, in the order the Studio offers them. */
export const PUZZLE_KINDS = [
  'logic',
  'code',
  'sequence',
  'pattern',
] as const satisfies readonly PuzzleKind[];

/** How a puzzle is answered. */
export type PuzzleAnswerType = 'text' | 'number' | 'choice' | 'order';

/** Every answer type, in the order the Studio offers them. */
export const PUZZLE_ANSWER_TYPES = [
  'text',
  'number',
  'choice',
  'order',
] as const satisfies readonly PuzzleAnswerType[];

/** The longest a question may be. */
export const MAX_PUZZLE_QUESTION_LENGTH = 1000;

/** The most answers an author may accept. */
export const MAX_ACCEPTED_ANSWERS = 50;

/** The longest one answer may be, written by the author or by the team. */
export const MAX_PUZZLE_ANSWER_LENGTH = 200;

/** The fewest and the most choices a puzzle may offer. */
export const MIN_PUZZLE_CHOICES = 2;
export const MAX_PUZZLE_CHOICES = 20;

/** The longest a choice id may be. */
export const MAX_CHOICE_ID_LENGTH = 40;

/** The longest a choice label may be. */
export const MAX_CHOICE_LABEL_LENGTH = 200;

/** Something besides spaces. The platform anchors a pattern (EXPD-009). */
const NOT_BLANK = '\\s*\\S[\\s\\S]*';

/** A plain decimal with a dot: `8`, `-3.5`, `.25`, `1e3`. */
const PLAIN_NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i;

/** What `prepare` makes of a config, once per mission. */
export type PreparedPuzzle =
  | {
      readonly kind: PuzzleKind;
      readonly answerType: 'text';
      readonly caseSensitive: boolean;
      readonly ignoreSpaces: boolean;
      /** The accepted answers, in the form they are compared in. */
      readonly accepted: ReadonlySet<string>;
    }
  | {
      readonly kind: PuzzleKind;
      readonly answerType: 'number';
      readonly accepted: readonly number[];
      readonly tolerance: number;
    }
  | {
      readonly kind: PuzzleKind;
      readonly answerType: 'choice';
      readonly correct: ReadonlySet<string>;
    }
  | {
      readonly kind: PuzzleKind;
      readonly answerType: 'order';
      readonly correct: readonly string[];
    };

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/** The form a typed answer is compared in. */
export function puzzleTextKey(
  text: string,
  options: { caseSensitive: boolean; ignoreSpaces: boolean },
): string {
  const spaced = options.ignoreSpaces
    ? text.replace(/\s+/g, '')
    : text.trim().replace(/\s+/g, ' ');
  return options.caseSensitive ? spaced : spaced.toLowerCase();
}

/** A typed number, or `undefined` when the text is not a plain decimal. */
export function parsePuzzleNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!PLAIN_NUMBER.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/** The choice ids, in the order written, each kept once. */
function choiceIds(config: JsonObject): string[] {
  const ids: string[] = [];
  const raw = Array.isArray(config['choices']) ? config['choices'] : [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }
    const id = entry['id'];
    if (typeof id === 'string' && !ids.includes(id)) {
      ids.push(id);
    }
  }
  return ids;
}

/** Turns an author's config into what an answer is judged against. */
export function preparePuzzle(config: JsonObject): PreparedPuzzle {
  const kind = oneOf(PUZZLE_KINDS, config['kind'], 'logic');
  const answerType = oneOf(PUZZLE_ANSWER_TYPES, config['answerType'], 'text');

  if (answerType === 'number') {
    const accepted = strings(config['acceptedAnswers'])
      .map(parsePuzzleNumber)
      .filter((value): value is number => value !== undefined);
    const raw = config['tolerance'];
    const tolerance = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
    return { kind, answerType, accepted, tolerance };
  }

  if (answerType === 'choice' || answerType === 'order') {
    const ids = choiceIds(config);
    const listed = answerType === 'choice' ? 'correctChoices' : 'correctOrder';
    const known = [...new Set(strings(config[listed]))].filter((id) => ids.includes(id));
    if (answerType === 'choice') {
      return { kind, answerType, correct: new Set(known) };
    }
    return { kind, answerType, correct: config[listed] === undefined ? ids : known };
  }

  const options = {
    caseSensitive: config['caseSensitive'] === true,
    ignoreSpaces: config['ignoreSpaces'] === true,
  };
  const accepted = new Set(
    strings(config['acceptedAnswers'])
      .map((answer) => puzzleTextKey(answer, options))
      .filter((key) => key !== ''),
  );
  return { kind, answerType, ...options, accepted };
}

/** Whether a prepared puzzle has an answer code can judge against. */
function hasAnswer(rules: PreparedPuzzle): boolean {
  switch (rules.answerType) {
    case 'text':
      return rules.accepted.size > 0;
    case 'number':
      return rules.accepted.length > 0;
    case 'choice':
      return rules.correct.size > 0;
    case 'order':
      return rules.correct.length > 0;
  }
}

/** The submission field each answer type reads. */
const ANSWER_FIELD = {
  text: 'answer',
  number: 'answer',
  choice: 'selected',
  order: 'order',
} as const satisfies Record<PuzzleAnswerType, string>;

const WRONG = 'Not quite. Try again.';

/** The puzzle type: its definition, and the code that judges an answer. */
export const puzzle: MissionTypeEntry = defineMissionType({
  definition: {
    key: PUZZLE_KEY,
    version: PUZZLE_VERSION,
    name: 'Puzzle',
    description:
      'Teams solve a logic, code, sequence or pattern puzzle and answer it in the app.',
    status: 'published',
    capabilities: [],
    configSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: [...PUZZLE_KINDS] },
        question: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_PUZZLE_QUESTION_LENGTH,
          pattern: NOT_BLANK,
        },
        answerType: { type: 'string', enum: [...PUZZLE_ANSWER_TYPES] },
        acceptedAnswers: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_ACCEPTED_ANSWERS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_PUZZLE_ANSWER_LENGTH,
            pattern: NOT_BLANK,
          },
        },
        caseSensitive: { type: 'boolean' },
        ignoreSpaces: { type: 'boolean' },
        tolerance: { type: 'number', minimum: 0 },
        choices: {
          type: 'array',
          minItems: MIN_PUZZLE_CHOICES,
          maxItems: MAX_PUZZLE_CHOICES,
          items: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_CHOICE_ID_LENGTH,
                pattern: NOT_BLANK,
              },
              label: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_CHOICE_LABEL_LENGTH,
                pattern: NOT_BLANK,
              },
            },
            required: ['id', 'label'],
          },
        },
        correctChoices: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_PUZZLE_CHOICES,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: MAX_CHOICE_ID_LENGTH },
        },
        correctOrder: {
          type: 'array',
          minItems: MIN_PUZZLE_CHOICES,
          maxItems: MAX_PUZZLE_CHOICES,
          uniqueItems: true,
          items: { type: 'string', minLength: 1, maxLength: MAX_CHOICE_ID_LENGTH },
        },
      },
      required: ['kind', 'question', 'answerType'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', maxLength: MAX_PUZZLE_ANSWER_LENGTH },
        selected: {
          type: 'array',
          maxItems: MAX_PUZZLE_CHOICES,
          uniqueItems: true,
          items: { type: 'string', maxLength: MAX_CHOICE_ID_LENGTH },
        },
        order: {
          type: 'array',
          maxItems: MAX_PUZZLE_CHOICES,
          items: { type: 'string', maxLength: MAX_CHOICE_ID_LENGTH },
        },
      },
      minProperties: 1,
    },
    defaultConfig: {
      kind: 'code',
      question: 'Write the puzzle here.',
      answerType: 'text',
      acceptedAnswers: ['CHANGE-ME'],
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedPuzzle {
      return preparePuzzle(config);
    },
    evaluate({ config, prepared, submission }) {
      const rules = (prepared as PreparedPuzzle | undefined) ?? preparePuzzle(config);
      const field = ANSWER_FIELD[rules.answerType];
      const given = submission[field];
      const detail: JsonObject = {
        kind: rules.kind,
        answerType: rules.answerType,
        [field]: given ?? null,
      };

      const missing =
        given === undefined ||
        (typeof given === 'string' && given.trim() === '') ||
        (Array.isArray(given) && given.length === 0);
      if (missing) {
        return { outcome: 'incorrect', progress: 0, feedback: 'Give your answer first.', detail };
      }

      if (!hasAnswer(rules)) {
        return {
          outcome: 'needs-review',
          feedback: 'Answer received. Your teacher will check it.',
          detail,
        };
      }

      switch (rules.answerType) {
        case 'text': {
          const right =
            typeof given === 'string' && rules.accepted.has(puzzleTextKey(given, rules));
          return right
            ? { outcome: 'correct', progress: 1, feedback: 'Puzzle solved.', detail }
            : { outcome: 'incorrect', progress: 0, feedback: WRONG, detail };
        }
        case 'number': {
          const value = typeof given === 'string' ? parsePuzzleNumber(given) : undefined;
          if (value === undefined) {
            return { outcome: 'incorrect', progress: 0, feedback: 'Answer with a number.', detail };
          }
          const right = rules.accepted.some(
            (accepted) => Math.abs(accepted - value) <= rules.tolerance,
          );
          return right
            ? { outcome: 'correct', progress: 1, feedback: 'Puzzle solved.', detail }
            : { outcome: 'incorrect', progress: 0, feedback: WRONG, detail };
        }
        case 'choice': {
          const picked = new Set(Array.isArray(given) ? given : []);
          const right =
            picked.size === rules.correct.size &&
            [...rules.correct].every((id) => picked.has(id));
          return right
            ? { outcome: 'correct', progress: 1, feedback: 'Puzzle solved.', detail }
            : { outcome: 'incorrect', progress: 0, feedback: WRONG, detail };
        }
        case 'order': {
          const order = Array.isArray(given) ? given : [];
          const inPlace = rules.correct.filter((id, index) => order[index] === id).length;
          const total = rules.correct.length;
          detail['inPlace'] = inPlace;
          if (inPlace === total && order.length === total) {
            return { outcome: 'correct', progress: 1, feedback: 'Puzzle solved.', detail };
          }
          return {
            outcome: 'incorrect',
            progress: inPlace / total,
            feedback: `${inPlace} of ${total} in the right place.`,
            detail,
          };
        }
      }
    },
  },
});

/**
 * What the Studio shows a new puzzle mission starting with (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0012 has
 * one source to be checked against. Only `question` and `choices` are placed
 * in the layout: every other field is, or tunes, the answer.
 */
export const PUZZLE_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: false },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'config-field', field: 'question', heading: 'Puzzle' },
      { kind: 'config-field', field: 'choices', heading: 'Choose from' },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'Check answer',
  },
};
