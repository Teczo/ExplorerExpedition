/**
 * The few pieces of UI the Studio's own screens share (EXPD-024).
 */

import type { ReactNode } from 'react';

export const inputClass =
  'mt-1 block w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-slate-100 focus:border-sky-500 focus:outline-none';

export const primaryButtonClass =
  'w-full rounded-md bg-sky-600 px-4 py-2 font-medium text-white hover:bg-sky-500 disabled:opacity-50';

export const secondaryButtonClass =
  'rounded-md border border-slate-700 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800';

/** A card in the middle of the screen, for the screens before the shell opens. */
export function CenteredCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-4 text-slate-100">
      <div className="w-full max-w-sm">
        <p className="text-sm font-medium tracking-widest text-slate-400 uppercase">
          Explorer Expedition
        </p>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
        <p className="mt-1 mb-6 text-slate-400">{subtitle}</p>
        {children}
      </div>
    </main>
  );
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="mt-4 rounded-md border border-red-900 bg-red-950 px-3 py-2 text-sm text-red-200">
      {children}
    </p>
  );
}

/** Shown while a sign-in is being restored after a reload. */
export function Loading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 text-slate-400">
      Loading…
    </main>
  );
}
