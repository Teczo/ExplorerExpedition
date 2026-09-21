/**
 * Checking what a request sent (EXPD-016).
 *
 * A handler should never read `request.body` and wonder. It reads a value it
 * has already been told is the right shape, or it never runs:
 *
 *     const Body = object({
 *       name: string({ min: 1, max: 120 }),
 *       missionCount: integer({ min: 1, max: 200 }),
 *       visibility: oneOf(['private', 'organisation'] as const),
 *       notes: optional(string({ max: 2000 })),
 *     });
 *
 *     router.post('/expeditions', validateBody(Body), (request, response) => {
 *       const body = bodyOf(request, Body);  // typed, and already checked
 *       ...
 *     });
 *
 * Everything wrong with a request is reported at once, each with the path to
 * the field, because a client that has to fix one mistake per round trip is a
 * client whose user gives up:
 *
 *     {
 *       "error": "validation-failed",
 *       "message": "Some of what was sent is not valid.",
 *       "details": [
 *         { "path": "name", "message": "This is required." },
 *         { "path": "missionCount", "message": "This has to be 200 or less." }
 *       ]
 *     }
 *
 * This is hand-written rather than a schema library, because adding one means
 * adding a dependency and no ticket has been allowed to — the same rule that
 * left a linter out of the pipeline and a migration runner out of `db/`. It
 * is deliberately small: enough to check the shape of a request, and no more.
 * The shape of an expedition document is not checked here at all —
 * `validateExpeditionDefinition` (EXPD-002) owns that, and `definition()`
 * below is how a route defers to it.
 */

import type { Request, RequestHandler } from 'express';

import { ValidationError, type FieldIssue } from './errors.ts';

/**
 * Something that turns an unknown value into a checked one.
 *
 * `check` is given the value and the path it was found at, and answers with
 * either the value it accepts or the reasons it does not. A checker never
 * throws for a value it dislikes; throwing is for a checker that is itself
 * wrong.
 */
export interface Checker<TValue> {
  check(value: unknown, path: string): CheckResult<TValue>;
  /**
   * True when the field may be left out entirely. Only `optional()` sets it,
   * and only `object()` reads it.
   */
  readonly isOptional?: boolean;
}

/** What a checker answers with. */
export type CheckResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly issues: readonly FieldIssue[] };

/** The type a checker produces. */
export type Checked<TChecker> = TChecker extends Checker<infer TValue> ? TValue : never;

/** The type an object checker's fields produce, together. */
export type CheckedShape<TShape extends Record<string, Checker<unknown>>> = {
  [TKey in keyof TShape]: Checked<TShape[TKey]>;
};

const ok = <TValue>(value: TValue): CheckResult<TValue> => ({ ok: true, value });

const bad = (path: string, message: string): CheckResult<never> => ({
  ok: false,
  issues: [{ path, message }],
});

/** Joins a parent path to a child key, the way a caller would write it. */
function join(path: string, key: string): string {
  return path === '' ? key : `${path}.${key}`;
}

/** Joins a parent path to an array index. */
function index(path: string, at: number): string {
  return `${path}[${at}]`;
}

// --- The checkers -----------------------------------------------------------

/** A string, optionally bounded in length and matched against a pattern. */
export function string(
  options: {
    readonly min?: number;
    readonly max?: number;
    readonly pattern?: RegExp;
    /** What to say when the pattern does not match. */
    readonly patternMessage?: string;
    /** Strips surrounding whitespace before checking. On by default. */
    readonly trim?: boolean;
  } = {},
): Checker<string> {
  const { min = 0, max = Number.MAX_SAFE_INTEGER, trim = true } = options;

  return {
    check(value, path) {
      if (typeof value !== 'string') {
        return bad(path, 'This has to be text.');
      }

      const text = trim ? value.trim() : value;
      if (text.length < min) {
        return bad(
          path,
          min === 1
            ? 'This cannot be empty.'
            : `This has to be at least ${min} characters.`,
        );
      }
      if (text.length > max) {
        return bad(path, `This has to be ${max} characters or fewer.`);
      }
      if (options.pattern !== undefined && !options.pattern.test(text)) {
        return bad(path, options.patternMessage ?? 'This is not in the right format.');
      }
      return ok(text);
    },
  };
}

/** A whole number, optionally bounded. */
export function integer(
  options: { readonly min?: number; readonly max?: number } = {},
): Checker<number> {
  return {
    check(value, path) {
      const asNumber = typeof value === 'string' ? Number(value) : value;
      if (typeof asNumber !== 'number' || !Number.isInteger(asNumber)) {
        return bad(path, 'This has to be a whole number.');
      }
      if (options.min !== undefined && asNumber < options.min) {
        return bad(path, `This has to be ${options.min} or more.`);
      }
      if (options.max !== undefined && asNumber > options.max) {
        return bad(path, `This has to be ${options.max} or less.`);
      }
      return ok(asNumber);
    },
  };
}

/**
 * A true or false.
 *
 * `'true'` and `'false'` are accepted as well, because a query string has no
 * way to say a boolean and every client spells it that way.
 */
export function boolean(): Checker<boolean> {
  return {
    check(value, path) {
      if (typeof value === 'boolean') {
        return ok(value);
      }
      if (value === 'true') {
        return ok(true);
      }
      if (value === 'false') {
        return ok(false);
      }
      return bad(path, 'This has to be true or false.');
    },
  };
}

/** One of a closed list of values. */
export function oneOf<const TValue extends string>(
  allowed: readonly TValue[],
): Checker<TValue> {
  return {
    check(value, path) {
      if (typeof value !== 'string' || !allowed.includes(value as TValue)) {
        return bad(path, `This has to be one of: ${allowed.join(', ')}.`);
      }
      return ok(value as TValue);
    },
  };
}

/**
 * An id as this platform writes them: a UUID.
 *
 * Every primary key in the schema (EXPD-003) is a `uuid`, so a value that is
 * not one cannot match a row and is worth refusing before a statement is
 * built rather than after it comes back empty.
 */
export function id<TId extends string = string>(): Checker<TId> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    check(value, path) {
      if (typeof value !== 'string' || !uuid.test(value)) {
        return bad(path, 'This has to be an id.');
      }
      return ok(value as TId);
    },
  };
}

/** An RFC 3339 timestamp, handed on as a `Date`. */
export function timestamp(): Checker<Date> {
  return {
    check(value, path) {
      if (typeof value !== 'string') {
        return bad(path, 'This has to be a date and time.');
      }
      const when = new Date(value);
      if (Number.isNaN(when.getTime())) {
        return bad(path, 'This has to be a date and time, such as 2026-03-01T09:00:00Z.');
      }
      return ok(when);
    },
  };
}

/** A list, every entry checked by the same checker. */
export function array<TValue>(
  entry: Checker<TValue>,
  options: { readonly min?: number; readonly max?: number } = {},
): Checker<TValue[]> {
  return {
    check(value, path) {
      if (!Array.isArray(value)) {
        return bad(path, 'This has to be a list.');
      }
      if (options.min !== undefined && value.length < options.min) {
        return bad(path, `This needs at least ${options.min} entries.`);
      }
      if (options.max !== undefined && value.length > options.max) {
        return bad(path, `This can hold at most ${options.max} entries.`);
      }

      const checked: TValue[] = [];
      const issues: FieldIssue[] = [];
      value.forEach((item, at) => {
        const result = entry.check(item, index(path, at));
        if (result.ok) {
          checked.push(result.value);
        } else {
          issues.push(...result.issues);
        }
      });

      return issues.length === 0 ? ok(checked) : { ok: false, issues };
    },
  };
}

/**
 * An object with a known set of fields.
 *
 * Unknown fields are refused, not ignored. A client that misspells `name` as
 * `tittle` should be told so, rather than watch the field silently not take
 * effect — and a field the API does not know is the shape a request smuggling
 * something in takes.
 */
export function object<TShape extends Record<string, Checker<unknown>>>(
  shape: TShape,
): Checker<CheckedShape<TShape>> {
  const keys = Object.keys(shape);

  return {
    check(value, path) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return bad(path, 'This has to be an object.');
      }

      const source = value as Record<string, unknown>;
      const checked: Record<string, unknown> = {};
      const issues: FieldIssue[] = [];

      for (const key of keys) {
        const checker = shape[key];
        if (checker === undefined) {
          continue;
        }

        const at = join(path, key);
        const field = source[key];

        if (field === undefined || field === null) {
          if (checker.isOptional === true) {
            const empty = checker.check(undefined, at);
            if (empty.ok && empty.value !== undefined) {
              checked[key] = empty.value;
            }
            continue;
          }
          issues.push({ path: at, message: 'This is required.' });
          continue;
        }

        const result = checker.check(field, at);
        if (result.ok) {
          checked[key] = result.value;
        } else {
          issues.push(...result.issues);
        }
      }

      for (const key of Object.keys(source)) {
        if (!keys.includes(key)) {
          issues.push({ path: join(path, key), message: 'This field is not recognised.' });
        }
      }

      return issues.length === 0
        ? ok(checked as CheckedShape<TShape>)
        : { ok: false, issues };
    },
  };
}

/** A field that may be left out. Absent reads as `undefined`. */
export function optional<TValue>(inner: Checker<TValue>): Checker<TValue | undefined> {
  return {
    isOptional: true,
    check(value, path) {
      return value === undefined || value === null ? ok(undefined) : inner.check(value, path);
    },
  };
}

/** A field that may be left out, and stands for something when it is. */
export function withDefault<TValue>(
  inner: Checker<TValue>,
  fallback: TValue,
): Checker<TValue> {
  return {
    isOptional: true,
    check(value, path) {
      return value === undefined || value === null ? ok(fallback) : inner.check(value, path);
    },
  };
}

/**
 * Anything at all, handed on untouched.
 *
 * For the one case that matters: a body whose shape belongs to somebody else.
 * An expedition document is checked by `validateExpeditionDefinition`
 * (EXPD-002) and a mission's `config` by its mission type (EXPD-009), and
 * neither of those belongs in this file.
 */
export function unchecked(): Checker<unknown> {
  return { check: (value) => ok(value) };
}

/**
 * Defers to a checker somebody else wrote.
 *
 * `issuesOf` turns whatever that checker reports into this file's issues, so
 * the caller sees one error contract whichever validator found the problem.
 */
export function definition<TValue>(
  validate: (value: unknown) => { readonly valid: boolean; readonly issues?: unknown },
  issuesOf: (issues: unknown, path: string) => readonly FieldIssue[],
): Checker<TValue> {
  return {
    check(value, path) {
      const result = validate(value);
      if (result.valid) {
        return ok(value as TValue);
      }
      const issues = issuesOf(result.issues, path);
      return {
        ok: false,
        issues: issues.length === 0 ? [{ path, message: 'This is not valid.' }] : issues,
      };
    },
  };
}

// --- Putting a checker in front of a route ----------------------------------

/** Where on the request a checked value is kept. */
type CheckedPart = 'body' | 'query' | 'params';

declare global {
  namespace Express {
    interface Request {
      /** What the validation middleware accepted. Read it with `bodyOf` and friends. */
      checked?: Partial<Record<CheckedPart, unknown>>;
    }
  }
}

/** Refuses the request unless the body is the shape the checker wants. */
export function validateBody<TValue>(checker: Checker<TValue>): RequestHandler {
  return validatePart('body', checker);
}

/**
 * Refuses the request unless the query string is the shape the checker wants.
 *
 * Every value arrives as text, so use `integer()` and `boolean()` rather than
 * trying to read a number off `request.query` by hand.
 */
export function validateQuery<TValue>(checker: Checker<TValue>): RequestHandler {
  return validatePart('query', checker);
}

/** Refuses the request unless the path parameters are the shape the checker wants. */
export function validateParams<TValue>(checker: Checker<TValue>): RequestHandler {
  return validatePart('params', checker);
}

function validatePart<TValue>(part: CheckedPart, checker: Checker<TValue>): RequestHandler {
  return (request, _response, next) => {
    // `express.json()` leaves the body undefined when a request sent none, or
    // sent one that did not claim to be JSON. A route that wanted a body is
    // better served by being told which fields are missing than by being told
    // the body is not an object, so an absent body is checked as an empty one.
    const sent = part === 'body' && request.body === undefined ? {} : request[part];

    const result = checker.check(sent, '');
    if (!result.ok) {
      next(new ValidationError(result.issues.map(prefixed(part))));
      return;
    }

    request.checked = { ...request.checked, [part]: result.value };
    next();
  };
}

/**
 * Says which part of the request a problem is in.
 *
 * A path of `limit` means nothing on its own when it could have come from
 * either the body or the query string, so a query issue is reported as
 * `?limit` and a path parameter as `:id`.
 */
function prefixed(part: CheckedPart): (issue: FieldIssue) => FieldIssue {
  const mark = part === 'query' ? '?' : part === 'params' ? ':' : '';
  return (issue) => ({ ...issue, path: `${mark}${issue.path}` });
}

/** Reads the checked body, and throws if no `validateBody` ran in front. */
export function bodyOf<TValue>(request: Request, _checker: Checker<TValue>): TValue {
  return checkedPartOf(request, 'body', 'validateBody') as TValue;
}

/** Reads the checked query, and throws if no `validateQuery` ran in front. */
export function queryOf<TValue>(request: Request, _checker: Checker<TValue>): TValue {
  return checkedPartOf(request, 'query', 'validateQuery') as TValue;
}

/** Reads the checked path parameters, and throws if no `validateParams` ran in front. */
export function paramsOf<TValue>(request: Request, _checker: Checker<TValue>): TValue {
  return checkedPartOf(request, 'params', 'validateParams') as TValue;
}

function checkedPartOf(request: Request, part: CheckedPart, middleware: string): unknown {
  const value = request.checked?.[part];
  if (value === undefined) {
    throw new Error(
      `This handler read the checked ${part}, but no ${middleware}() runs in front of it.`,
    );
  }
  return value;
}
