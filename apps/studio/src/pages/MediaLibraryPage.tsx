/**
 * The media library (EXPD-030): the images, audio, video, PDFs and 3D models
 * an organisation's missions, mission types and templates share.
 *
 * Upload a file, rename it, give it alt text, look at it, and remove it. A
 * file is placed on a mission from the graph editor's property panel.
 */

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { ApiError } from '../auth/api-client.ts';
import { useSession } from '../auth/AuthProvider.tsx';
import {
  ACCEPTED_FILES,
  KIND_LABELS,
  MEDIA_KINDS,
  contentTypeOf,
  formatBytes,
  kindOf,
  mediaLibraryApi,
  nameFromFile,
  type LibraryItem,
  type MediaKind,
  type MediaLibraryApi,
} from '../media/library.ts';
import { ErrorNote, inputClass, secondaryButtonClass } from '../shell/ui.tsx';

const STEP_LABELS = {
  signing: 'Asking for an upload URL…',
  uploading: 'Uploading…',
  checking: 'Checking it arrived…',
} as const;

function messageOf(caught: unknown, fallback: string): string {
  if (caught instanceof ApiError || caught instanceof Error) {
    return caught.message;
  }
  return fallback;
}

export function MediaLibraryPage() {
  const session = useSession();
  const api = useMemo(() => mediaLibraryApi((path, init) => session.request(path, init)), [session]);

  const [items, setItems] = useState<readonly LibraryItem[] | null>(null);
  const [kind, setKind] = useState<MediaKind | 'all'>('all');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await api.list(kind === 'all' ? undefined : kind));
    } catch (caught) {
      setError(messageOf(caught, 'The media library could not be read.'));
    }
  }, [api, kind]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section>
      <h1 className="text-2xl font-semibold">Media library</h1>
      <p className="mt-2 text-slate-300">
        Images, audio, video, PDFs and 3D models for this organisation. Upload a file once, then add it to any mission
        from the graph editor.
      </p>

      <UploadForm api={api} onUploaded={() => void load()} />

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Show">
        {(['all', ...MEDIA_KINDS] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            className={`${secondaryButtonClass} ${kind === option ? 'border-sky-500 text-sky-200' : ''}`}
            onClick={() => setKind(option)}
          >
            {option === 'all' ? 'All' : KIND_LABELS[option]}
          </button>
        ))}
      </div>

      {error !== null && <ErrorNote>{error}</ErrorNote>}
      {items === null && error === null && <p className="mt-6 text-slate-400">Loading…</p>}
      {items !== null && items.length === 0 && <p className="mt-6 text-slate-400">No files here yet.</p>}
      {items !== null && items.length > 0 && (
        <table className="mt-4 w-full max-w-5xl text-left text-sm">
          <thead className="text-slate-400">
            <tr>
              <th className="py-2 font-normal">Name and alt text</th>
              <th className="py-2 font-normal">Kind</th>
              <th className="py-2 font-normal">Size</th>
              <th className="py-2 font-normal">Status</th>
              <th className="py-2 font-normal" />
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <LibraryRow key={item.id} item={item} api={api} onChanged={() => void load()} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function UploadForm({ api, onUploaded }: { api: MediaLibraryApi; onUploaded: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [altText, setAltText] = useState('');
  const [step, setStep] = useState<keyof typeof STEP_LABELS | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inputKey, setInputKey] = useState(0);

  const contentType = file === null ? null : contentTypeOf(file);
  const kind = contentType === null ? null : kindOf(contentType);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (file === null) return;
    setError(null);
    try {
      await api.upload(file, { name, altText }, setStep);
      setFile(null);
      setName('');
      setAltText('');
      setInputKey((current) => current + 1);
    } catch (caught) {
      setError(messageOf(caught, 'The file could not be uploaded.'));
    } finally {
      setStep(null);
      // A failed upload can leave a pending file behind, so the list is read
      // again either way.
      onUploaded();
    }
  };

  return (
    <form className="mt-6 max-w-3xl space-y-3 rounded-lg border border-slate-800 p-4" onSubmit={(event) => void submit(event)}>
      <h2 className="font-semibold">Upload a file</h2>
      <label className="block text-sm text-slate-300">
        File
        <input
          key={inputKey}
          type="file"
          accept={ACCEPTED_FILES}
          className="mt-1 block w-full text-sm text-slate-300"
          onChange={(event) => {
            const picked = event.target.files?.[0] ?? null;
            setFile(picked);
            if (picked !== null && name.trim() === '') setName(nameFromFile(picked.name));
          }}
        />
      </label>
      {file !== null && (
        <p className="text-xs text-slate-400">
          {kind === null
            ? 'This kind of file is not taken. Use an image, audio, video, a PDF, or a 3D model (.glb, .gltf, .usdz).'
            : `${KIND_LABELS[kind]}, ${contentType}, ${formatBytes(file.size)}`}
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm text-slate-300">
          Name
          <input className={inputClass} value={name} maxLength={200} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="block text-sm text-slate-300">
          Alt text (read aloud in place of the file)
          <input
            className={inputClass}
            value={altText}
            maxLength={1000}
            onChange={(event) => setAltText(event.target.value)}
          />
        </label>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className={secondaryButtonClass}
          disabled={file === null || kind === null || name.trim() === '' || step !== null}
        >
          Upload
        </button>
        {step !== null && <span className="text-sm text-slate-400">{STEP_LABELS[step]}</span>}
      </div>
      {error !== null && <ErrorNote>{error}</ErrorNote>}
    </form>
  );
}

function LibraryRow({ item, api, onChanged }: { item: LibraryItem; api: MediaLibraryApi; onChanged: () => void }) {
  const [name, setName] = useState(item.name);
  const [altText, setAltText] = useState(item.altText ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const changed = name.trim() !== item.name || altText.trim() !== (item.altText ?? '');

  const act = async (action: () => Promise<unknown>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      onChanged();
    } catch (caught) {
      setError(messageOf(caught, fallback));
    } finally {
      setBusy(false);
    }
  };

  const show = async () => {
    setError(null);
    try {
      const url = await api.downloadUrl(item.id);
      if (item.kind === 'image') {
        setPreview(url);
      } else {
        window.open(url, '_blank', 'noopener');
      }
    } catch (caught) {
      setError(messageOf(caught, 'The file could not be opened.'));
    }
  };

  return (
    <tr className="border-t border-slate-800 align-top">
      <td className="space-y-1 py-2 pr-3">
        <input
          className={inputClass}
          aria-label="Name"
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
        <input
          className={inputClass}
          aria-label="Alt text"
          placeholder="Alt text"
          value={altText}
          maxLength={1000}
          onChange={(event) => setAltText(event.target.value)}
        />
        {preview !== null && <img src={preview} alt={item.altText ?? ''} className="mt-2 max-h-48 rounded-md" />}
        {error !== null && <ErrorNote>{error}</ErrorNote>}
      </td>
      <td className="py-2">{KIND_LABELS[item.kind]}</td>
      <td className="py-2">{formatBytes(item.byteSize)}</td>
      <td className="py-2">{item.status === 'pending' ? 'Upload not finished' : item.status}</td>
      <td className="space-x-2 py-2 text-right whitespace-nowrap">
        {changed && (
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy || name.trim() === ''}
            onClick={() =>
              void act(() => api.update(item.id, { name: name.trim(), altText: altText.trim() }), 'The change was not saved.')
            }
          >
            Save
          </button>
        )}
        {item.status === 'pending' && (
          <button
            type="button"
            className={secondaryButtonClass}
            disabled={busy}
            onClick={() => void act(() => api.complete(item.id), 'The upload could not be checked.')}
          >
            Check upload
          </button>
        )}
        {item.status === 'ready' && (
          <button type="button" className={secondaryButtonClass} onClick={() => void show()}>
            {item.kind === 'image' ? 'Preview' : 'Open'}
          </button>
        )}
        <button
          type="button"
          className={secondaryButtonClass}
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Remove “${item.name}” from the library? Missions that show it will lose it.`)) {
              void act(() => api.remove(item.id), 'The file could not be removed.');
            }
          }}
        >
          Remove
        </button>
      </td>
    </tr>
  );
}
