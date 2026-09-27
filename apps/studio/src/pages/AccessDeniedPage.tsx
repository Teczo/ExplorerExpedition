import { useSession } from '../auth/AuthProvider.tsx';
import { CenteredCard, secondaryButtonClass } from '../shell/ui.tsx';

export function AccessDeniedPage({ displayName }: { displayName: string | null }) {
  const session = useSession();
  return (
    <CenteredCard title="No access to Studio" subtitle="Studio is for the Explorer team only.">
      <p className="text-slate-300">
        {displayName ? `${displayName}, your` : 'Your'} account is not on the Explorer team, so it
        cannot open Studio. You have been signed out.
      </p>
      <p className="mt-3 text-slate-400">
        If you build expeditions for a school, use the Creator app instead.
      </p>
      <button type="button" className={`mt-6 ${secondaryButtonClass}`} onClick={() => session.startOver()}>
        Sign in with another account
      </button>
    </CenteredCard>
  );
}
