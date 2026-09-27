/**
 * The calls the Studio makes to the API's auth routes (EXPD-004, EXPD-024).
 *
 * Nothing here holds state. `session.ts` decides when to call what; this file
 * only knows the shape of each request and answer, and turns every failure
 * into one `ApiError` so the caller has one thing to branch on.
 */

import type { OrgRole, OrganisationId, Permission, Principal, UserId } from '@explorer/shared-types';

/** One organisation the signed-in person may act for. */
export interface AvailableOrganisation {
  readonly organisationId: OrganisationId;
  readonly name: string;
  readonly slug: string;
  readonly orgRole: OrgRole;
}

/** An access token for one organisation. */
export interface IssuedAccessToken {
  readonly accessToken: string;
  readonly expiresAt: string;
  readonly organisationId: OrganisationId;
  readonly orgRole: OrgRole;
}

/** What `POST /auth/sign-in` answers. */
export interface SignInAnswer {
  readonly userId: UserId;
  readonly displayName: string;
  readonly isPlatformAdmin: boolean;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly organisations: readonly AvailableOrganisation[];
  readonly accessToken: IssuedAccessToken | null;
}

/** What `POST /auth/refresh` answers. */
export interface RefreshAnswer {
  readonly userId: UserId;
  readonly refreshToken: string;
  readonly refreshTokenExpiresAt: string;
  readonly organisations: readonly AvailableOrganisation[];
}

/** What `GET /auth/me` answers. */
export interface MeAnswer {
  readonly principal: Principal;
  readonly permissions: readonly Permission[];
}

/**
 * A call that did not succeed.
 *
 * `code` is the API's stable `error` code, or `network-error` when no answer
 * came back at all. `message` is for a person and nothing should branch on it.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** The auth calls, bound to one API. */
export interface AuthClient {
  signIn(email: string, password: string): Promise<SignInAnswer>;
  accessToken(refreshToken: string, organisationId: OrganisationId): Promise<IssuedAccessToken>;
  refresh(refreshToken: string): Promise<RefreshAnswer>;
  signOut(refreshToken: string): Promise<void>;
  me(accessToken: string): Promise<MeAnswer>;
}

/** The `fetch` this file needs. A test passes its own. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Builds the auth calls for the API at `baseUrl`.
 *
 * `baseUrl` has no trailing slash: `/api`, or `https://api.example.com`.
 */
export function createAuthClient(
  baseUrl: string,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): AuthClient {
  const post = <T>(path: string, body: unknown): Promise<T> =>
    call<T>(fetchImpl, `${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    signIn: (email, password) => post('/auth/sign-in', { email, password }),
    accessToken: (refreshToken, organisationId) =>
      post('/auth/token', { refreshToken, organisationId }),
    refresh: (refreshToken) => post('/auth/refresh', { refreshToken }),
    signOut: async (refreshToken) => {
      await post<null>('/auth/sign-out', { refreshToken });
    },
    me: (accessToken) =>
      call(fetchImpl, `${baseUrl}/auth/me`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
  };
}

/** Makes one call and reads the answer, or throws an `ApiError`. */
export async function call<T>(fetchImpl: Fetch, url: string, init: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(url, init);
  } catch {
    throw new ApiError(0, 'network-error', 'The Explorer API could not be reached.');
  }

  if (response.status === 204) {
    return null as T;
  }

  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const fields = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const code = typeof fields['error'] === 'string' ? fields['error'] : 'unexpected-answer';
    const message =
      typeof fields['message'] === 'string'
        ? fields['message']
        : `The Explorer API answered ${response.status}.`;
    throw new ApiError(response.status, code, message);
  }

  return body as T;
}
