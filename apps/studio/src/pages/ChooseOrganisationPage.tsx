import { useState } from 'react';
import type { OrganisationId } from '@explorer/shared-types';

import { useSession } from '../auth/AuthProvider.tsx';
import type { AvailableOrganisation } from '../auth/api-client.ts';
import { CenteredCard, ErrorNote, secondaryButtonClass } from '../shell/ui.tsx';

export function ChooseOrganisationPage({
  displayName,
  organisations,
  error,
}: {
  displayName: string;
  organisations: readonly AvailableOrganisation[];
  error: string | null;
}) {
  const session = useSession();
  const [busy, setBusy] = useState<OrganisationId | null>(null);

  const choose = async (organisationId: OrganisationId) => {
    setBusy(organisationId);
    await session.chooseOrganisation(organisationId);
    setBusy(null);
  };

  return (
    <CenteredCard
      title="Choose an organisation"
      subtitle={`${displayName ? `${displayName}, which` : 'Which'} organisation are you working in?`}
    >
      <ul className="space-y-2">
        {organisations.map((organisation) => (
          <li key={organisation.organisationId}>
            <button
              type="button"
              className="w-full rounded-md border border-slate-700 px-4 py-3 text-left hover:border-slate-500 hover:bg-slate-800 disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void choose(organisation.organisationId)}
            >
              <span className="block font-medium">{organisation.name}</span>
              <span className="block text-sm text-slate-400">{organisation.slug}</span>
            </button>
          </li>
        ))}
      </ul>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
      <button type="button" className={`mt-6 ${secondaryButtonClass}`} onClick={() => void session.signOut()}>
        Sign out
      </button>
    </CenteredCard>
  );
}
