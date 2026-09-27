/**
 * Mission types: the list, and the builder (EXPD-025).
 *
 * The router matches whole paths only (EXPD-024), so opening one type is a
 * state of this page rather than a path of its own.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import { ApiError } from '../auth/api-client.ts';
import { useSession } from '../auth/AuthProvider.tsx';
import { missionTypeApi, type MissionTypeView } from '../mission-types/api.ts';
import { Builder } from '../mission-types/Builder.tsx';
import { ErrorNote, secondaryButtonClass } from '../shell/ui.tsx';

type Open = { readonly kind: 'list' } | { readonly kind: 'type'; readonly type: MissionTypeView | null };

export function MissionTypesPage() {
  const session = useSession();
  const api = useMemo(() => missionTypeApi((path, init) => session.request(path, init)), [session]);

  const [types, setTypes] = useState<readonly MissionTypeView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>({ kind: 'list' });

  const load = useCallback(async () => {
    setError(null);
    try {
      setTypes(await api.list());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The mission types could not be read.');
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  if (open.kind === 'type') {
    return (
      <Builder
        key={open.type?.id ?? 'new'}
        existing={open.type}
        api={api}
        onSaved={(saved) => {
          setOpen({ kind: 'type', type: saved });
          void load();
        }}
        onClose={() => setOpen({ kind: 'list' })}
      />
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Mission types</h1>
        <button type="button" className={secondaryButtonClass} onClick={() => setOpen({ kind: 'type', type: null })}>
          New mission type
        </button>
      </div>
      <p className="mt-2 text-slate-300">
        The kinds of task an expedition is built from. A type built here is saved as a draft of this organisation.
      </p>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {types === null && error === null && <p className="mt-6 text-slate-400">Loading…</p>}
      {types !== null && types.length === 0 && <p className="mt-6 text-slate-400">No mission types yet.</p>}
      {types !== null && types.length > 0 && (
        <table className="mt-6 w-full max-w-5xl text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-normal">Name</th>
              <th className="py-2 font-normal">Key</th>
              <th className="py-2 font-normal">Status</th>
              <th className="py-2 font-normal">Owner</th>
              <th className="py-2 font-normal">Validation</th>
              <th className="py-2 font-normal">Base points</th>
            </tr>
          </thead>
          <tbody>
            {types.map((type) => (
              <tr key={type.id} className="border-t border-slate-800">
                <td className="py-2">
                  <button
                    type="button"
                    className="text-sky-300 hover:underline"
                    onClick={() => setOpen({ kind: 'type', type })}
                  >
                    {type.name}
                  </button>
                </td>
                <td className="py-2 font-mono text-xs">
                  {type.key}@{type.version}
                </td>
                <td className="py-2">{type.status}</td>
                <td className="py-2">{type.owner}</td>
                <td className="py-2">{type.validationMethod}</td>
                <td className="py-2">{type.defaultScoring.basePoints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
