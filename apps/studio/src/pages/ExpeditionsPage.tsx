/**
 * Expeditions: the list, and the graph editor (EXPD-026).
 *
 * The router matches whole paths only (EXPD-024), so opening one expedition
 * is a state of this page rather than a path of its own, the same as the
 * mission types screen.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { ApiError } from '../auth/api-client.ts';
import { useSession } from '../auth/AuthProvider.tsx';
import { expeditionApi, type ExpeditionDocumentView, type ExpeditionView } from '../expeditions/api.ts';
import { GraphEditor } from '../expeditions/GraphEditor.tsx';
import { mediaLibraryApi, type LibraryItem } from '../media/library.ts';
import { missionTypeApi, type MissionTypeView } from '../mission-types/api.ts';
import { ErrorNote, inputClass, secondaryButtonClass } from '../shell/ui.tsx';

type Open =
  | { readonly kind: 'list' }
  | { readonly kind: 'graph'; readonly expedition: ExpeditionView; readonly opened: ExpeditionDocumentView };

export function ExpeditionsPage() {
  const session = useSession();
  const request = useCallback(
    <T,>(path: string, init?: RequestInit) => session.request<T>(path, init),
    [session],
  );
  const api = useMemo(() => expeditionApi(request), [request]);
  const types = useMemo(() => missionTypeApi(request), [request]);
  const media = useMemo(() => mediaLibraryApi(request), [request]);

  const [expeditions, setExpeditions] = useState<readonly ExpeditionView[] | null>(null);
  const [missionTypes, setMissionTypes] = useState<readonly MissionTypeView[]>([]);
  const [library, setLibrary] = useState<readonly LibraryItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Open>({ kind: 'list' });
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, typeList, files] = await Promise.all([api.list(), types.list(), media.list()]);
      setExpeditions(list);
      setMissionTypes(typeList);
      setLibrary(files);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The expeditions could not be read.');
    }
  }, [api, types, media]);

  useEffect(() => {
    void load();
  }, [load]);

  const openOne = async (expedition: ExpeditionView) => {
    setBusy(true);
    setError(null);
    try {
      setOpen({ kind: 'graph', expedition, opened: await api.open(expedition) });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The expedition could not be opened.');
    } finally {
      setBusy(false);
    }
  };

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.create(title.trim());
      const expedition: ExpeditionView = {
        id: String(created.definition['id']),
        title: title.trim(),
        summary: '',
        updatedAt: created.version.updatedAt,
        draft: created.version,
        published: null,
      };
      setTitle('');
      setOpen({ kind: 'graph', expedition, opened: created });
      void load();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The expedition could not be created.');
    } finally {
      setBusy(false);
    }
  };

  if (open.kind === 'graph') {
    return (
      <GraphEditor
        key={open.expedition.id}
        expedition={open.expedition}
        opened={open.opened}
        missionTypes={missionTypes}
        library={library}
        api={api}
        onClose={() => {
          setOpen({ kind: 'list' });
          void load();
        }}
      />
    );
  }

  return (
    <section>
      <h1 className="text-2xl font-semibold">Expedition graphs</h1>
      <p className="mt-2 text-slate-300">
        Lay out an expedition's stops and the ways between them. Changes are saved as a draft of this organisation.
      </p>

      <form className="mt-4 flex max-w-xl items-end gap-2" onSubmit={(event) => void create(event)}>
        <label className="flex-1 text-xs text-slate-400">
          New expedition
          <input
            className={inputClass}
            value={title}
            placeholder="A walk round the museum"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <button type="submit" className={`${secondaryButtonClass} mb-0.5`} disabled={busy || title.trim() === ''}>
          Create
        </button>
      </form>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {expeditions === null && error === null && <p className="mt-6 text-slate-400">Loading…</p>}
      {expeditions !== null && expeditions.length === 0 && <p className="mt-6 text-slate-400">No expeditions yet.</p>}
      {expeditions !== null && expeditions.length > 0 && (
        <table className="mt-6 w-full max-w-5xl text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-normal">Title</th>
              <th className="py-2 font-normal">Draft</th>
              <th className="py-2 font-normal">Published</th>
              <th className="py-2 font-normal">Last changed</th>
            </tr>
          </thead>
          <tbody>
            {expeditions.map((expedition) => (
              <tr key={expedition.id} className="border-t border-slate-800">
                <td className="py-2">
                  <button
                    type="button"
                    className="text-sky-300 hover:underline disabled:opacity-50"
                    disabled={busy}
                    onClick={() => void openOne(expedition)}
                  >
                    {expedition.title}
                  </button>
                </td>
                <td className="py-2">{expedition.draft === null ? '—' : `revision ${expedition.draft.definitionVersion}`}</td>
                <td className="py-2">
                  {expedition.published === null ? '—' : `revision ${expedition.published.definitionVersion}`}
                </td>
                <td className="py-2 text-slate-400">{expedition.updatedAt.slice(0, 16).replace('T', ' ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
