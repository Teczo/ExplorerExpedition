import { useState, type FormEvent } from 'react';

import { useSession } from '../auth/AuthProvider.tsx';
import { CenteredCard, ErrorNote, inputClass, primaryButtonClass } from '../shell/ui.tsx';

export function SignInPage({ error }: { error: string | null }) {
  const session = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    await session.signIn(email.trim(), password);
    setBusy(false);
    setPassword('');
  };

  return (
    <CenteredCard title="Sign in to Studio" subtitle="Internal. For the Explorer team only.">
      <form className="space-y-4" onSubmit={submit}>
        <label className="block">
          <span className="text-sm text-slate-300">Email</span>
          <input
            className={inputClass}
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label className="block">
          <span className="text-sm text-slate-300">Password</span>
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error !== null && <ErrorNote>{error}</ErrorNote>}
        <button className={primaryButtonClass} type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </CenteredCard>
  );
}
