/**
 * The frame every Studio screen is drawn inside (EXPD-024).
 *
 * A header with who is signed in and for which organisation, a side
 * navigation, and the page. Later tickets add a screen by adding a line to
 * `routes.tsx`; they do not touch this file.
 */

import type { ReactNode } from 'react';

import { useAuthState, useSession } from '../auth/AuthProvider.tsx';
import { Link, usePath } from '../router.tsx';
import { NAVIGATION } from '../routes.tsx';
import { secondaryButtonClass } from './ui.tsx';

export function Shell({ children }: { children: ReactNode }) {
  const session = useSession();
  const state = useAuthState();
  const path = usePath();

  if (state.status !== 'signed-in') {
    return null;
  }

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div className="flex items-baseline gap-3">
          <span className="text-sm font-medium tracking-widest text-slate-400 uppercase">
            Explorer Expedition
          </span>
          <span className="font-semibold">Studio</span>
          <span className="rounded bg-amber-900/60 px-2 py-0.5 text-xs text-amber-200">Internal</span>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <span className="text-slate-300">
            {state.displayName || state.principal.userId}
            <span className="text-slate-500"> · {state.organisation.name}</span>
          </span>
          {state.organisations.length > 1 && (
            <button type="button" className={secondaryButtonClass} onClick={() => session.switchOrganisation()}>
              Switch organisation
            </button>
          )}
          <button type="button" className={secondaryButtonClass} onClick={() => void session.signOut()}>
            Sign out
          </button>
        </div>
      </header>
      <div className="flex flex-1">
        <nav aria-label="Studio" className="w-56 shrink-0 border-r border-slate-800 p-4">
          <ul className="space-y-1">
            {NAVIGATION.map((item) => {
              const active = path === item.path;
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    aria-current={active ? 'page' : undefined}
                    className={`block rounded-md px-3 py-2 text-sm ${
                      active ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-900'
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <main className="min-w-0 flex-1 px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
