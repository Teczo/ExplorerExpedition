/**
 * When the clock starts and stops, read out of the revision a run is pinned
 * to (EXPD-019).
 *
 * `TimingRules` (EXPD-002) says how a run begins, what ends it, and how long
 * it may last. The run carries none of that: it carries
 * `expedition_version_id`, and the revision carries the document. So the
 * rules are read from the document every time they are needed, and a class
 * that started on revision 3 plays revision 3's clock however much the author
 * changes afterwards — the same reasoning `participation/team-rules.ts` gives
 * for the team limits, and for the same reason.
 *
 * The one thing a run does carry is `extended_seconds_total`, and that is why
 * it has a column rather than a field in the document: the document is frozen
 * when it is published, and a teacher giving a class ten more minutes because
 * the coach was late is not editing what the class is playing.
 *
 * Everything here reads the document defensively, for the reason
 * `team-rules.ts` gives: `expedition_version.definition` is `jsonb`, so what
 * comes back is JSON and not a typed object, and a revision written against
 * an older schema may be short of a field. A missing field falls back rather
 * than throwing, because refusing to start a lesson over an optional field
 * would be the worse failure by a distance.
 */

import type { EndMode, JsonObject, StartMode, TimingRules } from '@explorer/shared-types';
import { END_MODES, START_MODES } from '@explorer/shared-types';

/**
 * What the timing is taken to be when the document does not say.
 *
 * Open on purpose. A run whose document is short of `rules.timing` is a run
 * the teacher starts and the teacher stops, with no clock over it — which is
 * the one fallback that cannot cut a lesson short by accident.
 */
export const DEFAULT_TIMING_RULES: TimingRules = {
  startMode: 'synchronised',
  endMode: 'teacher-ends',
};

/**
 * The longest time limit this file will read out of a document.
 *
 * Twenty-four hours. A limit beyond that is not a lesson, and a document
 * carrying one is more likely to be carrying milliseconds by mistake.
 */
export const MAX_TIME_LIMIT_SECONDS = 86_400;

/** The longest countdown this file will read out of a document. */
export const MAX_COUNTDOWN_SECONDS = 3_600;

/**
 * Reads `rules.timing` out of a stored document.
 *
 * Each field is taken only when it is the right shape, and falls back to
 * `DEFAULT_TIMING_RULES` when it is not. The two optional durations are
 * dropped rather than defaulted: "no limit" and "a limit this file could not
 * read" should look the same to everything downstream, and both mean the
 * clock does not end the run.
 */
export function timingRulesOf(definition: JsonObject | null | undefined): TimingRules {
  const rules = objectAt(definition, 'rules');
  const timing = objectAt(rules, 'timing');
  if (timing === null) {
    return DEFAULT_TIMING_RULES;
  }

  const limit = secondsAt(timing['totalTimeLimitSeconds'], MAX_TIME_LIMIT_SECONDS);
  const countdown = secondsAt(timing['countdownSeconds'], MAX_COUNTDOWN_SECONDS);

  return {
    startMode: startModeOf(timing['startMode']),
    endMode: endModeOf(timing['endMode']),
    ...(limit === null ? {} : { totalTimeLimitSeconds: limit }),
    ...(countdown === null ? {} : { countdownSeconds: countdown }),
  };
}

/**
 * How long this run may last in all, extensions included.
 *
 * `null` means no limit, and a run with no limit runs until somebody ends it.
 * Time given on the day is added to the document's number rather than
 * replacing it, so a run extended twice by five minutes is ten minutes longer
 * than the author wrote and not five.
 */
export function timeLimitOf(
  rules: TimingRules,
  extendedSeconds: number,
): number | null {
  const limit = rules.totalTimeLimitSeconds;
  if (limit === undefined) {
    return null;
  }
  return limit + Math.max(0, Math.trunc(extendedSeconds));
}

/**
 * Returns true when the expedition's own clock is what ends a run.
 *
 * Only `time-limit` is that. Every other end mode may still carry a limit —
 * EXPD-002 allows one as a backstop — and a backstop is a thing the clock
 * counts down to rather than a thing that ends the lesson on its own.
 */
export function endsOnTime(rules: TimingRules): boolean {
  return rules.endMode === 'time-limit';
}

function startModeOf(value: unknown): StartMode {
  return (START_MODES as readonly string[]).includes(value as string)
    ? (value as StartMode)
    : DEFAULT_TIMING_RULES.startMode;
}

function endModeOf(value: unknown): EndMode {
  return (END_MODES as readonly string[]).includes(value as string)
    ? (value as EndMode)
    : DEFAULT_TIMING_RULES.endMode;
}

/** A whole number of seconds inside a range, or null when it is neither. */
function secondsAt(value: unknown, high: number): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return null;
  }
  return value < 1 || value > high ? null : value;
}

function objectAt(
  parent: JsonObject | Record<string, unknown> | null | undefined,
  key: string,
): Record<string, unknown> | null {
  if (parent === null || parent === undefined) {
    return null;
  }
  return asObject((parent as Record<string, unknown>)[key]);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
