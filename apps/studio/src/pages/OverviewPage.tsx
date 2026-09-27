import { useAuthState } from '../auth/AuthProvider.tsx';

export function OverviewPage() {
  const state = useAuthState();
  if (state.status !== 'signed-in') {
    return null;
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Studio</h1>
      <p className="mt-2 text-slate-300">
        Authoring tool for mission types, expedition graphs and scoring rules.
      </p>
      <dl className="mt-8 grid max-w-xl grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
        <dt className="text-slate-400">Signed in as</dt>
        <dd>{state.displayName || state.principal.userId}</dd>
        <dt className="text-slate-400">Organisation</dt>
        <dd>{state.organisation.name}</dd>
        <dt className="text-slate-400">Access</dt>
        <dd>Explorer team</dd>
      </dl>
    </section>
  );
}
