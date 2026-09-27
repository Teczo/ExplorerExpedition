/**
 * The Studio's sign-in, from start to finish (EXPD-024).
 *
 * One object owns it, so there is one answer to "who is signed in" and one
 * place that talks to the auth routes. React reads it through
 * `AuthProvider`; nothing else writes to it.
 *
 * The steps follow the API's two-step sign-in (EXPD-004):
 *
 *   1. `signIn` sends the email and password and gets a refresh token and the
 *      organisations the person may act for. Somebody who is not on the
 *      Explorer team is stopped here, and their refresh token is revoked at
 *      once rather than left lying in the browser.
 *   2. With more than one organisation, the person picks one, and
 *      `chooseOrganisation` trades the refresh token for an access token.
 *   3. `GET /auth/me` confirms what the access token allows. The Studio opens
 *      only when the server says the principal holds `platform:administer`.
 *
 * Where things are kept:
 *
 *   - The access token lives in memory only. It lasts 15 minutes and is
 *     minted again from the refresh token when it runs low.
 *   - The refresh token lives in `sessionStorage`, so a reload does not sign
 *     the person out but closing the tab does. It rotates on every restore.
 *   - Neither is ever put in `localStorage` or a cookie.
 */

import type { OrganisationId, Permission, UserPrincipal } from '@explorer/shared-types';

import { hasStudioAccess } from './access.ts';
import {
  ApiError,
  call,
  type AuthClient,
  type AvailableOrganisation,
  type Fetch,
  type IssuedAccessToken,
} from './api-client.ts';

/** Where the Studio is in signing somebody in. */
export type AuthState =
  /** Finding out whether a sign-in survived a reload. */
  | { readonly status: 'loading' }
  /** Nobody is signed in. `error` says why the last attempt failed. */
  | { readonly status: 'signed-out'; readonly error: string | null }
  /** Signed in, and waiting to be told which organisation to act for. */
  | {
      readonly status: 'choosing-organisation';
      readonly displayName: string;
      readonly organisations: readonly AvailableOrganisation[];
      readonly error: string | null;
    }
  /** The account is real but is not on the Explorer team. */
  | { readonly status: 'denied'; readonly displayName: string | null }
  /** In. */
  | {
      readonly status: 'signed-in';
      readonly displayName: string;
      readonly organisation: AvailableOrganisation;
      readonly organisations: readonly AvailableOrganisation[];
      readonly principal: UserPrincipal;
      readonly permissions: readonly Permission[];
    };

/** The part of `sessionStorage` this file uses. A test passes its own. */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface AuthSessionOptions {
  readonly client: AuthClient;
  readonly storage: KeyValueStore;
  /** The API root, for `request`. No trailing slash. */
  readonly baseUrl: string;
  readonly fetch?: Fetch;
  /** Milliseconds since the epoch. A test passes its own clock. */
  readonly now?: () => number;
}

/** The keys the Studio keeps in `sessionStorage`. */
export const STORAGE_KEYS = {
  refreshToken: 'explorer.studio.refreshToken',
  displayName: 'explorer.studio.displayName',
  organisationId: 'explorer.studio.organisationId',
} as const;

/** An access token with less than this left is minted again before use. */
const RENEW_BEFORE_MS = 60_000;

const NOT_A_PLATFORM_MEMBER =
  'This account is not a member of any organisation, so it cannot open the Studio.';
const SIGN_IN_ENDED = 'Your sign-in has ended. Sign in again.';

type Listener = () => void;

export class AuthSession {
  private readonly client: AuthClient;
  private readonly storage: KeyValueStore;
  private readonly baseUrl: string;
  private readonly fetchImpl: Fetch;
  private readonly now: () => number;

  private state: AuthState = { status: 'loading' };
  private readonly listeners = new Set<Listener>();

  private refreshToken: string | null = null;
  private displayName = '';
  private organisations: readonly AvailableOrganisation[] = [];
  private token: IssuedAccessToken | null = null;

  private restoring: Promise<void> | null = null;
  private renewing: Promise<string> | null = null;

  constructor(options: AuthSessionOptions) {
    this.client = options.client;
    this.storage = options.storage;
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.now = options.now ?? Date.now;
  }

  /** The current state. Stable between changes, as `useSyncExternalStore` needs. */
  getState = (): AuthState => this.state;

  /** Calls `listener` after every change. Returns a function that stops it. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Picks up a sign-in that survived a reload.
   *
   * Safe to call more than once: it runs once. That matters because a refresh
   * token works exactly once, and React calls effects twice in development —
   * a second refresh with the same token would end the sign-in.
   */
  restore(): Promise<void> {
    this.restoring ??= this.runRestore();
    return this.restoring;
  }

  /** Signs in with an email and a password. */
  async signIn(email: string, password: string): Promise<void> {
    let answer;
    try {
      answer = await this.client.signIn(email, password);
    } catch (error) {
      this.set({ status: 'signed-out', error: messageOf(error) });
      return;
    }

    this.refreshToken = answer.refreshToken;
    this.displayName = answer.displayName;
    this.organisations = answer.organisations;

    if (!answer.isPlatformAdmin) {
      await this.deny();
      return;
    }

    this.save();

    if (answer.accessToken !== null) {
      await this.open(answer.accessToken);
      return;
    }
    await this.pickOrganisation(null);
  }

  /** Acts for one organisation. Used from the organisation picker. */
  async chooseOrganisation(organisationId: OrganisationId): Promise<void> {
    if (this.refreshToken === null) {
      this.set({ status: 'signed-out', error: SIGN_IN_ENDED });
      return;
    }

    let token;
    try {
      token = await this.client.accessToken(this.refreshToken, organisationId);
    } catch (error) {
      if (isEnded(error)) {
        this.end(SIGN_IN_ENDED);
        return;
      }
      this.set({
        status: 'choosing-organisation',
        displayName: this.displayName,
        organisations: this.organisations,
        error: messageOf(error),
      });
      return;
    }
    await this.open(token);
  }

  /** Goes back to the organisation picker without signing out. */
  switchOrganisation(): void {
    if (this.state.status !== 'signed-in' || this.organisations.length < 2) {
      return;
    }
    this.token = null;
    this.set({
      status: 'choosing-organisation',
      displayName: this.displayName,
      organisations: this.organisations,
      error: null,
    });
  }

  /** Signs out, and tells the API to end the sign-in. */
  async signOut(): Promise<void> {
    await this.revoke();
    this.end(null);
  }

  /** Leaves the "not allowed" screen so another account can sign in. */
  startOver(): void {
    this.end(null);
  }

  /**
   * An access token good for at least another minute.
   *
   * Mints a new one from the refresh token when the current one runs low.
   * Two callers asking at once share one call.
   */
  async accessToken(): Promise<string> {
    const token = this.token;
    if (token !== null && Date.parse(token.expiresAt) - this.now() > RENEW_BEFORE_MS) {
      return token.accessToken;
    }
    this.renewing ??= this.renew().finally(() => {
      this.renewing = null;
    });
    return this.renewing;
  }

  /**
   * Calls the API as the signed-in person.
   *
   * This is what every later Studio screen uses to reach its endpoints. A 401
   * means the sign-in is over, and the Studio goes back to the sign-in page.
   */
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const accessToken = await this.accessToken();
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    if (init.body !== undefined && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json');
    }

    try {
      return await call<T>(this.fetchImpl, `${this.baseUrl}${path}`, { ...init, headers });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        this.end(SIGN_IN_ENDED);
      }
      throw error;
    }
  }

  // --- The steps ---

  private async runRestore(): Promise<void> {
    const stored = this.storage.getItem(STORAGE_KEYS.refreshToken);
    if (stored === null) {
      this.set({ status: 'signed-out', error: null });
      return;
    }

    let answer;
    try {
      answer = await this.client.refresh(stored);
    } catch (error) {
      // A network failure may have lost an answer that already rotated the
      // token, so the stored one cannot be trusted either way.
      this.end(isEnded(error) ? null : messageOf(error));
      return;
    }

    this.refreshToken = answer.refreshToken;
    this.displayName = this.storage.getItem(STORAGE_KEYS.displayName) ?? '';
    this.organisations = answer.organisations;
    this.save();

    const organisationId = this.storage.getItem(STORAGE_KEYS.organisationId);
    await this.pickOrganisation(organisationId as OrganisationId | null);
  }

  /**
   * Chooses the organisation without asking when there is only one answer:
   * the one used last time, or the only one there is.
   */
  private async pickOrganisation(preferred: OrganisationId | null): Promise<void> {
    if (this.organisations.length === 0) {
      await this.revoke();
      this.end(NOT_A_PLATFORM_MEMBER);
      return;
    }

    const known = this.organisations.find((each) => each.organisationId === preferred);
    const only = this.organisations.length === 1 ? this.organisations[0] : undefined;
    const chosen = known ?? only;

    if (chosen !== undefined) {
      await this.chooseOrganisation(chosen.organisationId);
      return;
    }

    this.set({
      status: 'choosing-organisation',
      displayName: this.displayName,
      organisations: this.organisations,
      error: null,
    });
  }

  /** Asks the server what the token allows, and opens the Studio if it may. */
  private async open(token: IssuedAccessToken): Promise<void> {
    let me;
    try {
      me = await this.client.me(token.accessToken);
    } catch (error) {
      if (isEnded(error)) {
        this.end(SIGN_IN_ENDED);
        return;
      }
      this.set({ status: 'signed-out', error: messageOf(error) });
      return;
    }

    const principal = me.principal;
    if (principal.kind !== 'user' || !hasStudioAccess(principal)) {
      await this.deny();
      return;
    }

    const organisation =
      this.organisations.find((each) => each.organisationId === token.organisationId) ?? {
        organisationId: token.organisationId,
        name: token.organisationId,
        slug: '',
        orgRole: token.orgRole,
      };

    this.token = token;
    this.storage.setItem(STORAGE_KEYS.organisationId, token.organisationId);
    this.set({
      status: 'signed-in',
      displayName: this.displayName,
      organisation,
      organisations: this.organisations,
      principal,
      permissions: me.permissions,
    });
  }

  private async renew(): Promise<string> {
    const organisationId = this.token?.organisationId;
    if (this.refreshToken === null || organisationId === undefined) {
      this.end(SIGN_IN_ENDED);
      throw new ApiError(401, 'session-ended', SIGN_IN_ENDED);
    }

    try {
      this.token = await this.client.accessToken(this.refreshToken, organisationId);
      return this.token.accessToken;
    } catch (error) {
      if (isEnded(error)) {
        this.end(SIGN_IN_ENDED);
      }
      throw error;
    }
  }

  /** Not on the Explorer team: end the sign-in and say so. */
  private async deny(): Promise<void> {
    const displayName = this.displayName || null;
    await this.revoke();
    this.forget();
    this.set({ status: 'denied', displayName });
  }

  // --- Bookkeeping ---

  /** Tells the API the refresh token is finished with. Never throws. */
  private async revoke(): Promise<void> {
    const refreshToken = this.refreshToken;
    if (refreshToken === null) {
      return;
    }
    try {
      await this.client.signOut(refreshToken);
    } catch {
      // Signing out locally still has to happen. The token expires on its own.
    }
  }

  private end(error: string | null): void {
    this.forget();
    this.set({ status: 'signed-out', error });
  }

  private save(): void {
    if (this.refreshToken !== null) {
      this.storage.setItem(STORAGE_KEYS.refreshToken, this.refreshToken);
    }
    this.storage.setItem(STORAGE_KEYS.displayName, this.displayName);
  }

  private forget(): void {
    this.refreshToken = null;
    this.token = null;
    this.displayName = '';
    this.organisations = [];
    this.storage.removeItem(STORAGE_KEYS.refreshToken);
    this.storage.removeItem(STORAGE_KEYS.displayName);
    this.storage.removeItem(STORAGE_KEYS.organisationId);
  }

  private set(state: AuthState): void {
    this.state = state;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

/** True when the API says the refresh or access token is no good any more. */
function isEnded(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

function messageOf(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Something went wrong. Try again.';
}
