/**
 * Hands the one `AuthSession` to the React tree (EXPD-024).
 */

import { createContext, useContext, useEffect, useSyncExternalStore, type ReactNode } from 'react';

import type { AuthSession, AuthState } from './session.ts';

const SessionContext = createContext<AuthSession | null>(null);

export function AuthProvider({ session, children }: { session: AuthSession; children: ReactNode }) {
  useEffect(() => {
    void session.restore();
  }, [session]);

  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

/** The session, for calling `signIn`, `signOut`, `request` and the rest. */
export function useSession(): AuthSession {
  const session = useContext(SessionContext);
  if (session === null) {
    throw new Error('useSession has to be used inside <AuthProvider>');
  }
  return session;
}

/** The current auth state. Redraws when it changes. */
export function useAuthState(): AuthState {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, session.getState);
}
