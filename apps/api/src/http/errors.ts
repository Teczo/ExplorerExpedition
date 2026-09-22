/**
 * What the API refuses, and what the caller is told (EXPD-016).
 *
 * Every error the API answers with has the same body, whichever part of the
 * code raised it:
 *
 *     { "error": "not-found", "message": "There is nothing at that address." }
 *
 * `error` is a stable code a client can branch on. `message` is English for a
 * person, and may be reworded at any time, so nothing should read it. A
 * validation failure adds `details`, and nothing else ever does.
 *
 * `AuthError` (EXPD-004) already answers in this shape, so the two are one
 * contract and not two that happen to look alike. That is the reason this
 * class does not try to replace it: auth codes say things only auth knows.
 *
 * The request id is not in the body. Every response carries it in the
 * `X-Request-Id` header instead (see `request-id.ts`), so a caller reporting
 * a problem has the same id to quote whether the response was an error or
 * not.
 */

/** Why a request was refused. */
export type ApiFailure =
  /** The request was malformed: unreadable JSON, a bad parameter. */
  | 'bad-request'
  /** The body or query was readable, but wrong. Carries `details`. */
  | 'validation-failed'
  /** Nothing lives at that address. */
  | 'not-found'
  /** That address exists, but not for that method. */
  | 'method-not-allowed'
  /** The body was not a media type this API reads. */
  | 'unsupported-media-type'
  /** The body was larger than the API accepts. */
  | 'payload-too-large'
  /** The request contradicts the state of something that already exists. */
  | 'conflict'
  /** Something the API depends on is not answering. */
  | 'service-unavailable'
  /** A fault on our side. The caller is told nothing else. */
  | 'internal-error';

/** The HTTP status each failure answers with. */
export const STATUS_BY_API_FAILURE: Readonly<Record<ApiFailure, number>> = {
  'bad-request': 400,
  'validation-failed': 422,
  'not-found': 404,
  'method-not-allowed': 405,
  'unsupported-media-type': 415,
  'payload-too-large': 413,
  conflict: 409,
  'service-unavailable': 503,
  'internal-error': 500,
};

/**
 * What the caller is told when nothing more specific was supplied.
 *
 * `internal-error` says nothing at all about what went wrong, on purpose. The
 * detail goes to the log, where the request id ties it back to the response
 * the caller saw.
 */
export const MESSAGE_BY_API_FAILURE: Readonly<Record<ApiFailure, string>> = {
  'bad-request': 'That request could not be read.',
  'validation-failed': 'Some of what was sent is not valid.',
  'not-found': 'There is nothing at that address.',
  'method-not-allowed': 'That address does not answer to that method.',
  'unsupported-media-type': 'This endpoint reads application/json.',
  'payload-too-large': 'That request body is too large.',
  conflict: 'That does not match the current state of this resource.',
  'service-unavailable': 'The API cannot serve that request at the moment.',
  'internal-error': 'Something went wrong on our side.',
};

/** One thing wrong with a request, and where it is. */
export interface FieldIssue {
  /**
   * Where the problem is, in the caller's own words for it: `name`,
   * `graph.edges[3].to`, `?limit`. A problem with the body as a whole has
   * the empty path.
   */
  readonly path: string;
  /** What is wrong with it, for a person. */
  readonly message: string;
}

/** The body every error response carries. */
export interface ApiErrorBody {
  readonly error: string;
  readonly message: string;
  readonly details?: readonly FieldIssue[];
  readonly refusal?: EngineRefusal;
}

/**
 * Why the Mission Engine said no (EXPD-020).
 *
 * Only a `conflict` carries one, and only when the engine made the call. The
 * engine's refusals are answers rather than faults — the wrong end of the
 * park, a second tap on submit, a hint already paid for — and a phone has to
 * tell them apart to say anything useful, so the engine's own code goes to
 * the caller with whatever else it said. `message` stays English for a
 * person; `refusal.code` is the stable thing to branch on.
 */
export interface EngineRefusal {
  /** The engine's refusal code, such as `wrong-place` or `no-attempts-left`. */
  readonly code: string;
  /** The rest of what the engine said, as it said it. */
  readonly [field: string]: unknown;
}

/** Thrown by a handler, or by anything in front of one, to refuse a request. */
export class ApiError extends Error {
  override readonly name: string = 'ApiError';

  /** What to answer with. */
  readonly status: number;

  /** Why it was refused. */
  readonly failure: ApiFailure;

  /** What went wrong field by field. Only a validation failure has any. */
  readonly details: readonly FieldIssue[];

  /**
   * What really happened, for the log. Never sent to the caller.
   *
   * Use it for the half of the story the caller must not be told: which of
   * the two credentials was wrong, which row already existed, which upstream
   * timed out.
   */
  readonly detail: string | undefined;

  /** The engine's refusal, when the engine is who refused. */
  readonly refusal: EngineRefusal | undefined;

  constructor(
    failure: ApiFailure,
    options: {
      /** Overrides the default message. Written for a person to read. */
      readonly message?: string;
      readonly details?: readonly FieldIssue[];
      readonly detail?: string;
      readonly refusal?: EngineRefusal;
      /** The error this one was raised from, kept for the log. */
      readonly cause?: unknown;
    } = {},
  ) {
    super(
      options.message ?? MESSAGE_BY_API_FAILURE[failure],
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.failure = failure;
    this.status = STATUS_BY_API_FAILURE[failure];
    this.details = options.details ?? [];
    this.detail = options.detail;
    this.refusal = options.refusal;
  }

  /** The body to send back. */
  toResponseBody(): ApiErrorBody {
    return {
      error: this.failure,
      message: this.message,
      ...(this.details.length === 0 ? {} : { details: this.details }),
      ...(this.refusal === undefined ? {} : { refusal: this.refusal }),
    };
  }
}

/**
 * Thrown when a request was readable but wrong.
 *
 * Separate from a plain `ApiError('validation-failed')` only so that a
 * handler can catch it, and so that `details` is never empty: an answer that
 * says something is invalid without saying what is not worth sending.
 */
export class ValidationError extends ApiError {
  override readonly name = 'ValidationError';

  constructor(details: readonly FieldIssue[], message?: string) {
    super('validation-failed', {
      ...(message === undefined ? {} : { message }),
      details: details.length === 0
        ? [{ path: '', message: 'This request is not valid.' }]
        : details,
    });
  }
}

/** Shorthand for the failure a handler raises most often. */
export function notFound(what?: string): ApiError {
  return new ApiError('not-found', {
    ...(what === undefined ? {} : { message: `There is no ${what} with that id.` }),
  });
}
