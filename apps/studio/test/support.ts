/**
 * Fakes for the Studio's auth tests: an API that answers from a script, and
 * an in-memory `sessionStorage`.
 */

import type { OrganisationId, Principal, UserId } from '@explorer/shared-types';
import { permissionsOf } from '@explorer/shared-types';

import {
  ApiError,
  type AuthClient,
  type AvailableOrganisation,
  type IssuedAccessToken,
  type MeAnswer,
  type RefreshAnswer,
  type SignInAnswer,
} from '../src/auth/api-client.ts';
import type { KeyValueStore } from '../src/auth/session.ts';

export const USER_ID = 'user-1' as UserId;

export function organisation(id: string, name = `Organisation ${id}`): AvailableOrganisation {
  return {
    organisationId: id as OrganisationId,
    name,
    slug: name.toLowerCase().replace(/\s+/g, '-'),
    orgRole: 'creator',
  };
}

export function accessToken(
  organisationId: string,
  expiresAt = '2030-01-01T00:00:00.000Z',
  token = `access-for-${organisationId}`,
): IssuedAccessToken {
  return {
    accessToken: token,
    expiresAt,
    organisationId: organisationId as OrganisationId,
    orgRole: 'creator',
  };
}

export function principal(organisationId: string, isPlatformAdmin: boolean): Principal {
  return {
    kind: 'user',
    userId: USER_ID,
    authSessionId: 'auth-session-1' as never,
    organisationId: organisationId as OrganisationId,
    orgRole: 'creator',
    isPlatformAdmin,
  };
}

export function meFor(organisationId: string, isPlatformAdmin = true): MeAnswer {
  const who = principal(organisationId, isPlatformAdmin);
  return { principal: who, permissions: permissionsOf(who) };
}

/** A fake API. Each field is what that call does; every call is recorded. */
export class FakeAuthClient implements AuthClient {
  readonly calls: string[] = [];
  readonly signedOut: string[] = [];

  onSignIn: (email: string, password: string) => Promise<SignInAnswer> = async () => {
    throw new Error('signIn not scripted');
  };
  onAccessToken: (refreshToken: string, organisationId: OrganisationId) => Promise<IssuedAccessToken> =
    async (_refreshToken, organisationId) => accessToken(organisationId);
  onRefresh: (refreshToken: string) => Promise<RefreshAnswer> = async () => {
    throw new Error('refresh not scripted');
  };
  onMe: (accessToken: string) => Promise<MeAnswer> = async (token) =>
    meFor(token.replace('access-for-', ''));

  signIn(email: string, password: string) {
    this.calls.push('signIn');
    return this.onSignIn(email, password);
  }
  accessToken(refreshToken: string, organisationId: OrganisationId) {
    this.calls.push(`accessToken:${organisationId}`);
    return this.onAccessToken(refreshToken, organisationId);
  }
  refresh(refreshToken: string) {
    this.calls.push(`refresh:${refreshToken}`);
    return this.onRefresh(refreshToken);
  }
  async signOut(refreshToken: string) {
    this.calls.push('signOut');
    this.signedOut.push(refreshToken);
  }
  me(token: string) {
    this.calls.push('me');
    return this.onMe(token);
  }
}

export function signInAnswer(overrides: Partial<SignInAnswer> = {}): SignInAnswer {
  return {
    userId: USER_ID,
    displayName: 'Ada',
    isPlatformAdmin: true,
    refreshToken: 'refresh-1',
    refreshTokenExpiresAt: '2030-01-01T00:00:00.000Z',
    organisations: [organisation('org-a')],
    accessToken: accessToken('org-a'),
    ...overrides,
  };
}

export function apiError(status: number, code: string, message = code): ApiError {
  return new ApiError(status, code, message);
}

export class MemoryStorage implements KeyValueStore {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
}
