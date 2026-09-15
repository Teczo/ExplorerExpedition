/**
 * What auth refuses, and why (EXPD-004).
 *
 * Each failure has a code the API turns into a status, and a message that is
 * safe to send back. The two are kept apart on purpose: the message a caller
 * sees says less than the code, because telling somebody whether an email has
 * an account is telling them something they did not know.
 */

/** Why a call was refused. */
export type AuthFailure =
  /** No credentials were presented at all. */
  | 'no-credentials'
  /** The email and password did not match an account. */
  | 'bad-credentials'
  /** The token was not one this platform signed, or has expired. */
  | 'bad-token'
  /** The refresh token has been withdrawn, or was used twice. */
  | 'session-ended'
  /** The account exists but cannot sign in: suspended, or deactivated. */
  | 'account-unavailable'
  /** The person has no active membership of the organisation they asked for. */
  | 'not-a-member'
  /** Signed in, but not allowed to do this. */
  | 'forbidden'
  /** The password offered for a change was not one the platform will store. */
  | 'weak-password';

/** The HTTP status each failure answers with. */
export const STATUS_BY_FAILURE: Readonly<Record<AuthFailure, number>> = {
  'no-credentials': 401,
  'bad-credentials': 401,
  'bad-token': 401,
  'session-ended': 401,
  'account-unavailable': 403,
  'not-a-member': 403,
  forbidden: 403,
  'weak-password': 422,
};

/**
 * What the caller is told.
 *
 * `bad-credentials` says nothing about which half was wrong, and
 * `not-a-member` says nothing about whether the organisation exists. An
 * answer that distinguished them would let anybody map out who works where.
 */
export const MESSAGE_BY_FAILURE: Readonly<Record<AuthFailure, string>> = {
  'no-credentials': 'This request needs an access token.',
  'bad-credentials': 'That email address and password do not match an account.',
  'bad-token': 'That access token is not valid.',
  'session-ended': 'That sign-in has ended. Sign in again.',
  'account-unavailable': 'That account cannot sign in at the moment.',
  'not-a-member': 'You do not have access to that organisation.',
  forbidden: 'You do not have permission to do that.',
  'weak-password': 'That password is not long enough.',
};

/** Thrown by the auth service when a call is refused. */
export class AuthError extends Error {
  override readonly name = 'AuthError';

  /** What to answer with. */
  readonly status: number;

  /** Why it was refused. */
  readonly failure: AuthFailure;

  /** What really happened, for the log. Never sent to the caller. */
  readonly detail: string | undefined;

  constructor(failure: AuthFailure, detail?: string) {
    super(MESSAGE_BY_FAILURE[failure]);
    this.failure = failure;
    this.detail = detail;
    this.status = STATUS_BY_FAILURE[failure];
  }

  /** The body to send back. */
  toResponseBody(): { readonly error: AuthFailure; readonly message: string } {
    return { error: this.failure, message: this.message };
  }
}
