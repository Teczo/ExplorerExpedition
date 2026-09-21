/**
 * What a fake team actually hands in (EXPD-015).
 *
 * The harness cannot know the answer to a mission. A QR hunt's codes are in
 * its config, a puzzle's answer is in its config, and only the mission type
 * knows which field is which — that is the whole point of the registry
 * (EXPD-009), and the harness is not allowed to unpick it.
 *
 * So a run needs something that can hand in work on a team's behalf. That is
 * a *player*: a function which, given a mission and whether this attempt is
 * meant to come out right, produces the payload the team submits. A mission
 * type that ships with the platform (EXPD-032 to EXPD-039) can bring one, and
 * a caller can pass one in for a type built in the Studio.
 *
 * Two are here. `samplingPlayer` builds a payload out of the type's own
 * submission schema, which is the most any caller can do without knowing the
 * type: it is the right shape, so a submission is never turned away for
 * being malformed, but a real behaviour will almost always judge it wrong.
 * `scriptedPlayer` (in `scripted.ts`) is the other way round — it is used
 * with the stand-in registry, where the payload *is* the intended outcome,
 * and it is what lets the harness estimate a duration for an expedition whose
 * mission types have no code behind them at all.
 *
 * **A player has to be pure**, for the reason `MissionTypeBehaviour` gives:
 * it is handed the run's own generator, and reading a clock or a global would
 * make the run stop reproducing.
 */

import type {
  ConfigSchema,
  JsonObject,
  JsonValue,
  MissionInstance,
  MissionTypeDefinition,
} from '@explorer/shared-types';

import type { Random } from './random.ts';

/** What the harness wants this attempt to come to. */
export type SimulatedIntent =
  /** The team is meant to get it right. */
  | 'correct'
  /** The team is meant to get it wrong. */
  | 'incorrect';

/** What a player is told before it writes a payload. */
export interface SimulatedPlayerInput {
  /** The mission being attempted, settings and all. */
  readonly mission: MissionInstance;
  /** The mission type it was registered as. */
  readonly definition: MissionTypeDefinition;
  /** What this attempt is meant to come to. */
  readonly intent: SimulatedIntent;
  /** Which try this is, counting from one. */
  readonly attemptNumber: number;
  /** The run's generator, for a player that wants to vary what it sends. */
  readonly random: Random;
}

/** Plays one mission type on a fake team's behalf. */
export type SimulatedPlayer = (input: SimulatedPlayerInput) => JsonObject;

/** How long a string a schema asked for but did not describe should be. */
const SAMPLE_STRING = 'simulated';

/**
 * A value of the shape a schema asks for.
 *
 * It satisfies every keyword the platform runs except `pattern`, which cannot
 * be satisfied without solving the expression — a payload that fails its own
 * schema comes back from the completion interface as an `invalid-submission`
 * refusal, and the run reports that rather than pretending it played the
 * mission.
 *
 * Exported because a mission type writing its own player usually wants the
 * shape and then one field changed.
 */
export function sampleValue(schema: ConfigSchema, random: Random, depth = 1): JsonValue {
  if (depth > 12) {
    return null;
  }
  if (schema.const !== undefined) {
    return schema.const;
  }
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return random.pick(schema.enum) ?? null;
  }
  if (schema.default !== undefined) {
    return schema.default;
  }

  switch (schema.type) {
    case 'object':
    case undefined:
      return sampleObject(schema, random, depth);
    case 'array':
      return sampleArray(schema, random, depth);
    case 'string':
      return sampleString(schema);
    case 'number':
    case 'integer':
      return sampleNumber(schema);
    case 'boolean':
      return true;
    case 'null':
      return null;
  }
}

/** An object holding every field the schema requires, and nothing else. */
function sampleObject(schema: ConfigSchema, random: Random, depth: number): JsonObject {
  const made: JsonObject = {};
  const properties = schema.properties ?? {};
  // Only the required fields. Sending every optional one as well would make a
  // team's submission say more than a real one does, and an optional field a
  // behaviour treats as a hint would quietly change the answer.
  for (const field of schema.required ?? []) {
    const inner = properties[field];
    made[field] = inner === undefined ? null : sampleValue(inner, random, depth + 1);
  }
  return made;
}

/** A list as short as the schema allows, holding samples of its item schema. */
function sampleArray(schema: ConfigSchema, random: Random, depth: number): JsonValue[] {
  const least = Math.max(0, Math.floor(schema.minItems ?? 0));
  const most = schema.maxItems === undefined ? least : Math.floor(schema.maxItems);
  const length = Math.max(0, Math.min(least, most === 0 ? 0 : most));
  const items = schema.items;
  const made: JsonValue[] = [];
  for (let index = 0; index < length; index += 1) {
    // `uniqueItems` wants entries that differ, and a sampled item schema does
    // not vary on its own, so the index is appended to a sampled string.
    const value = items === undefined ? null : sampleValue(items, random, depth + 1);
    made.push(
      schema.uniqueItems === true && typeof value === 'string'
        ? `${value}-${String(index)}`
        : value,
    );
  }
  return made;
}

/** A string long enough for the schema and no longer. */
function sampleString(schema: ConfigSchema): string {
  const least = Math.max(0, Math.floor(schema.minLength ?? 0));
  const most = schema.maxLength === undefined ? Infinity : Math.floor(schema.maxLength);
  const base = SAMPLE_STRING.length >= least ? SAMPLE_STRING : SAMPLE_STRING.padEnd(least, 'x');
  return base.length > most ? base.slice(0, Math.max(0, most)) : base;
}

/** A number inside every bound the schema set. */
function sampleNumber(schema: ConfigSchema): number {
  const whole = schema.type === 'integer';
  const step = schema.multipleOf !== undefined && schema.multipleOf > 0 ? schema.multipleOf : undefined;

  let low = schema.minimum ?? (schema.exclusiveMinimum === undefined ? 0 : schema.exclusiveMinimum + (whole ? 1 : 1e-6));
  const high = schema.maximum ?? (schema.exclusiveMaximum === undefined ? undefined : schema.exclusiveMaximum - (whole ? 1 : 1e-6));
  if (high !== undefined && low > high) {
    low = high;
  }

  let value = low;
  if (step !== undefined) {
    value = Math.ceil(low / step) * step;
    if (high !== undefined && value > high) {
      value = Math.floor(high / step) * step;
    }
  }
  return whole ? Math.round(value) : value;
}

/**
 * The player used when nobody supplied one for a mission type.
 *
 * It ignores the intent, because there is no way to honour it: the submission
 * schema says what a payload looks like and never what a right one holds. A
 * run that used this against a real behaviour will see almost every attempt
 * judged wrong, which is why the report says which types were played this way
 * (`sampled-mission-type`) rather than leaving a reader to conclude the
 * expedition is unwinnable.
 */
export const samplingPlayer: SimulatedPlayer = ({ definition, random }) => {
  const sampled = sampleValue(definition.submissionSchema, random);
  return typeof sampled === 'object' && sampled !== null && !Array.isArray(sampled)
    ? sampled
    : {};
};
