/**
 * The communication challenge mission type (EXPD-038).
 *
 * The information a team needs is split between its players, so the only way
 * to finish is to talk. The author writes the pieces as `parts`, and each
 * phone is shown only its own. Three patterns are covered, and `pattern`
 * tells the student app which one it is drawing:
 *
 *   - **Blind Rover** (`blind-rover`) — one player holds the map or the
 *     route; another walks it without seeing it, guided only by what they are
 *     told, and reads the code at the end.
 *   - **Radio Rescue** (`radio-rescue`) — each player holds a fragment (a
 *     bearing, a landmark, a call sign) and the team pieces them together into
 *     one answer, as if over a radio.
 *   - **Memory Relay** (`memory-relay`) — one player is shown something
 *     briefly (`showForSeconds`) and passes it on from memory, player to
 *     player, until the last one hands it in.
 *
 * **Who sees what.** `partsForSeat` decides, and the API's
 * `GET /sessions/:id/missions/:missionId/part` asks it for the phone calling:
 *
 *   1. A player sees every part whose `role` is their team role (EXPD-018
 *      hands roles out from `rules.teams.roles`).
 *   2. Parts with no `role` — and parts whose role nobody on the team holds,
 *      so no piece is ever lost — are dealt one each, in order, to the
 *      players who got nothing in step 1, in the order they joined the team.
 *      Dealing wraps round, so a team smaller than the number of parts still
 *      sees every one, and a team of one sees them all. When everybody got a
 *      part in step 1, the rest are dealt round the whole team.
 *
 * A player may be dealt nothing — the rover, the last runner of the relay.
 * That is the point: they have to be told.
 *
 * **The answer.** `answerType` says how the team answers:
 *
 *   - **`text`** — right when it matches one of `acceptedAnswers`, with spaces
 *     at either end ignored, runs of spaces counted as one, and case ignored.
 *   - **`sequence`** — the team hands in a list, right when every item
 *     matches `correctSequence` in place (compared the same way). Feedback
 *     and `progress` say how many are in the right place, so a relay that
 *     lost one item earns part of it when the mission allows partial credit.
 *
 * **The parts and the answer live in the config, and none of it is placed
 * in the student layout.** A part reaches a phone only through the part
 * endpoint, one player's share at a time; the answer never leaves the server.
 * The verdict's `detail` keeps what the team sent and never the answer.
 *
 * **What the schema cannot say.** The schema subset has no conditionals
 * (EXPD-009), so each `answerType` reads only its own fields; a challenge with
 * no usable answer goes to a teacher (`needs-review`) rather than turning
 * every answer away; and `showForSeconds` is honoured by the phone, which
 * this file can only tell.
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
export const COMMUNICATION_CHALLENGE_KEY = 'communication-challenge';

/** The version this file judges. */
export const COMMUNICATION_CHALLENGE_VERSION = '1.0.0';

/** Which of the three patterns a challenge is. */
export type CommunicationPattern = 'blind-rover' | 'radio-rescue' | 'memory-relay';

/** Every pattern, in the order the Studio offers them. */
export const COMMUNICATION_PATTERNS = [
  'blind-rover',
  'radio-rescue',
  'memory-relay',
] as const satisfies readonly CommunicationPattern[];

/** How a communication challenge is answered. */
export type CommunicationAnswerType = 'text' | 'sequence';

/** Every answer type, in the order the Studio offers them. */
export const COMMUNICATION_ANSWER_TYPES = [
  'text',
  'sequence',
] as const satisfies readonly CommunicationAnswerType[];

/** The most parts one challenge may split its information into. */
export const MAX_COMMUNICATION_PARTS = 12;

/** The longest a part's heading may be. */
export const MAX_PART_HEADING_LENGTH = 80;

/** The longest a part's text may be. */
export const MAX_PART_TEXT_LENGTH = 1000;

/** The longest a role name may be, as EXPD-018 stores it. */
export const MAX_PART_ROLE_LENGTH = 60;

/** The most accepted answers, or items in a sequence. */
export const MAX_COMMUNICATION_ANSWERS = 50;

/** The longest one answer, or one item of a sequence, may be. */
export const MAX_COMMUNICATION_ANSWER_LENGTH = 200;

/** Something besides spaces. The platform anchors a pattern (EXPD-009). */
const NOT_BLANK = '\\s*\\S[\\s\\S]*';

/** One piece of the split information. */
export interface CommunicationPart {
  /** Where it sits in the author's list, counting from nought. */
  readonly index: number;
  readonly heading: string;
  readonly text: string;
  /** The team role it is for, or `undefined` when it is dealt out. */
  readonly role: string | undefined;
  /** How long the phone may show it before hiding it, or `undefined` for as long as it likes. */
  readonly showForSeconds: number | undefined;
}

/** What `prepare` makes of a config, once per mission. */
export interface PreparedCommunicationChallenge {
  readonly pattern: CommunicationPattern;
  readonly parts: readonly CommunicationPart[];
  readonly answerType: CommunicationAnswerType;
  /** The accepted answers, in the form they are compared in. */
  readonly accepted: ReadonlySet<string>;
  /** The right sequence, in the form it is compared in. */
  readonly sequence: readonly string[];
}

/** One player on a team, as the part endpoint sees them. */
export interface CommunicationSeat {
  /** The live team member row's id. */
  readonly memberId: string;
  /** Their team role, or `null` for none. */
  readonly role: string | null;
}

/** The form an answer is compared in: trimmed, spaces collapsed, any case. */
export function communicationAnswerKey(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function isPattern(value: unknown): value is CommunicationPattern {
  return (
    typeof value === 'string' && (COMMUNICATION_PATTERNS as readonly string[]).includes(value)
  );
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function prepareParts(value: unknown): CommunicationPart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const parts: CommunicationPart[] = [];
  value.forEach((raw, index) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return;
    }
    const part = raw as JsonObject;
    const heading = part['heading'];
    const text = part['text'];
    const role = part['role'];
    const show = part['showForSeconds'];
    if (typeof heading !== 'string' || typeof text !== 'string') {
      return;
    }
    parts.push({
      index,
      heading: heading.trim(),
      text: text.trim(),
      role: typeof role === 'string' && role.trim() !== '' ? role.trim() : undefined,
      showForSeconds:
        typeof show === 'number' && Number.isFinite(show) && show > 0 ? show : undefined,
    });
  });
  return parts;
}

/** Turns an author's config into what a challenge is dealt out and judged with. */
export function prepareCommunicationChallenge(
  config: JsonObject,
): PreparedCommunicationChallenge {
  const keys = (value: unknown) =>
    strings(value)
      .map(communicationAnswerKey)
      .filter((item) => item !== '');
  return {
    pattern: isPattern(config['pattern']) ? config['pattern'] : 'radio-rescue',
    parts: prepareParts(config['parts']),
    answerType: config['answerType'] === 'sequence' ? 'sequence' : 'text',
    accepted: new Set(keys(config['acceptedAnswers'])),
    sequence: keys(config['correctSequence']),
  };
}

/**
 * The parts one player on a team is shown.
 *
 * `seats` is the whole team in the order its members joined, and `memberId`
 * is the player asking. The rules are the two at the top of this file. A
 * player who is not in `seats` is shown nothing.
 */
export function partsForSeat(
  parts: readonly CommunicationPart[],
  seats: readonly CommunicationSeat[],
  memberId: string,
): CommunicationPart[] {
  const me = seats.find((seat) => seat.memberId === memberId);
  if (me === undefined) {
    return [];
  }

  const heldRoles = new Set(seats.flatMap((seat) => (seat.role === null ? [] : [seat.role])));
  const byRole = (seat: CommunicationSeat) =>
    parts.filter((part) => part.role !== undefined && part.role === seat.role);
  const dealt = parts.filter((part) => part.role === undefined || !heldRoles.has(part.role));

  const empty = seats.filter((seat) => byRole(seat).length === 0);
  const table = empty.length > 0 ? empty : seats;
  const myPlace = table.findIndex((seat) => seat.memberId === memberId);
  const mine = new Set(byRole(me).map((part) => part.index));
  if (myPlace !== -1) {
    dealt.forEach((part, order) => {
      if (order % table.length === myPlace) {
        mine.add(part.index);
      }
    });
  }
  return parts.filter((part) => mine.has(part.index));
}

/** The communication challenge type: its definition, and the code that judges one. */
export const communicationChallenge: MissionTypeEntry = defineMissionType({
  definition: {
    key: COMMUNICATION_CHALLENGE_KEY,
    version: COMMUNICATION_CHALLENGE_VERSION,
    name: 'Communication challenge',
    description:
      'Information is split between players, and the team has to talk to put it together.',
    status: 'published',
    capabilities: [],
    configSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', enum: [...COMMUNICATION_PATTERNS] },
        parts: {
          type: 'array',
          minItems: 1,
          maxItems: MAX_COMMUNICATION_PARTS,
          items: {
            type: 'object',
            properties: {
              heading: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_PART_HEADING_LENGTH,
                pattern: NOT_BLANK,
              },
              text: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_PART_TEXT_LENGTH,
                pattern: NOT_BLANK,
              },
              role: {
                type: 'string',
                minLength: 1,
                maxLength: MAX_PART_ROLE_LENGTH,
                pattern: NOT_BLANK,
              },
              showForSeconds: { type: 'integer', minimum: 1 },
            },
            required: ['heading', 'text'],
          },
        },
        answerType: { type: 'string', enum: [...COMMUNICATION_ANSWER_TYPES] },
        acceptedAnswers: {
          type: 'array',
          maxItems: MAX_COMMUNICATION_ANSWERS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_COMMUNICATION_ANSWER_LENGTH,
            pattern: NOT_BLANK,
          },
        },
        correctSequence: {
          type: 'array',
          maxItems: MAX_COMMUNICATION_ANSWERS,
          items: {
            type: 'string',
            minLength: 1,
            maxLength: MAX_COMMUNICATION_ANSWER_LENGTH,
            pattern: NOT_BLANK,
          },
        },
      },
      required: ['pattern', 'parts', 'answerType'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        answer: { type: 'string', maxLength: MAX_COMMUNICATION_ANSWER_LENGTH },
        sequence: {
          type: 'array',
          maxItems: MAX_COMMUNICATION_ANSWERS,
          items: { type: 'string', maxLength: MAX_COMMUNICATION_ANSWER_LENGTH },
        },
      },
      required: [],
    },
    defaultConfig: {
      pattern: 'radio-rescue',
      parts: [
        { heading: 'Your fragment', text: 'Say what the first player knows.' },
        { heading: 'Your fragment', text: 'Say what the second player knows.' },
      ],
      answerType: 'text',
      acceptedAnswers: ['Say what the team has to work out.'],
    },
  },
  behaviour: {
    prepare(config: JsonObject): PreparedCommunicationChallenge {
      return prepareCommunicationChallenge(config);
    },
    evaluate({ config, prepared, submission }): MissionEvaluation {
      const challenge =
        (prepared as PreparedCommunicationChallenge | undefined) ??
        prepareCommunicationChallenge(config);

      if (challenge.answerType === 'sequence') {
        const sent = strings(submission['sequence']);
        const detail: JsonObject = { pattern: challenge.pattern, sequence: sent };
        const wanted = challenge.sequence;
        if (wanted.length === 0) {
          return {
            outcome: 'needs-review',
            feedback: 'Handed in. Your teacher will check it.',
            detail,
          };
        }
        if (sent.length === 0) {
          return {
            outcome: 'incorrect',
            progress: 0,
            feedback: 'Hand in the sequence your team put together.',
            detail,
          };
        }
        const inPlace = wanted.filter(
          (item, index) => sent[index] !== undefined && communicationAnswerKey(sent[index]) === item,
        ).length;
        if (inPlace === wanted.length && sent.length === wanted.length) {
          return { outcome: 'correct', progress: 1, feedback: 'Message received.', detail };
        }
        return {
          outcome: 'incorrect',
          progress: inPlace / Math.max(wanted.length, sent.length),
          feedback: `${String(inPlace)} of ${String(wanted.length)} in the right place.`,
          detail,
        };
      }

      const answer = submission['answer'];
      const sent = typeof answer === 'string' ? answer : '';
      const detail: JsonObject = { pattern: challenge.pattern, answer: sent };
      if (challenge.accepted.size === 0) {
        return {
          outcome: 'needs-review',
          feedback: 'Handed in. Your teacher will check it.',
          detail,
        };
      }
      if (sent.trim() === '') {
        return {
          outcome: 'incorrect',
          progress: 0,
          feedback: 'Hand in the answer your team put together.',
          detail,
        };
      }
      return challenge.accepted.has(communicationAnswerKey(sent))
        ? { outcome: 'correct', progress: 1, feedback: 'Message received.', detail }
        : {
            outcome: 'incorrect',
            progress: 0,
            feedback: 'Not quite. Check what each of you knows, and try again.',
            detail,
          };
    },
  },
});

/**
 * What the Studio shows a new communication challenge starting with
 * (EXPD-025).
 *
 * Kept beside the definition so that the platform row in migration 0015 has
 * one source to be checked against. No `config-field` block is placed: the
 * parts reach each phone through the part endpoint, one player's share at a
 * time, and a field placed here would show every part to every player.
 */
export const COMMUNICATION_CHALLENGE_AUTHORING: MissionTypeAuthoring = {
  validationMethod: 'automatic',
  defaultScoring: { basePoints: 100, allowPartialCredit: false },
  studentLayout: {
    blocks: [
      { kind: 'brief' },
      { kind: 'instructions' },
      { kind: 'media' },
      { kind: 'timer' },
      { kind: 'hints' },
      { kind: 'submission' },
    ],
    submitLabel: 'Send our answer',
  },
};
