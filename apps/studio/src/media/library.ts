/**
 * The media library (EXPD-030), as the Studio sees it: the calls, and the
 * few decisions about a file that can be made without a browser.
 *
 * Adding a file is three steps, and only the first and last go to the API:
 *
 *   1. `POST /media/library` writes a pending row and signs an upload URL.
 *   2. The browser PUTs the bytes straight to Blob Storage with that URL.
 *   3. `POST /media/library/:id/complete` has the API check the file arrived,
 *      and marks it ready.
 *
 * Only a ready file is offered for placing on a mission.
 */

import { MEDIA_KINDS, type MediaRef } from '@explorer/shared-types';

import type { Request } from '../mission-types/api.ts';

/** What a library file is: image, audio, video, document or a 3D model. */
export type MediaKind = MediaRef['kind'];

/** One library file, as the API answers with it. */
export interface LibraryItem {
  readonly id: string;
  readonly kind: MediaKind;
  readonly status: 'pending' | 'ready' | 'failed' | 'deleted';
  readonly name: string;
  readonly altText: string | null;
  readonly contentType: string | null;
  readonly byteSize: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The answer to asking for an upload. */
export interface UploadGrant {
  readonly media: LibraryItem;
  readonly upload: {
    readonly method: 'PUT';
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly expiresAt: string;
  };
}

export const KIND_LABELS: Readonly<Record<MediaKind, string>> = {
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
  document: 'PDF or document',
  model: '3D model',
};

export { MEDIA_KINDS };

/** What the file picker offers. */
export const ACCEPTED_FILES = 'image/*,audio/*,video/*,application/pdf,.glb,.gltf,.usdz';

/**
 * Types a browser often does not know, by file extension. A `.glb` comes
 * through with an empty type in most browsers, and the API needs one.
 */
const TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  usdz: 'model/vnd.usdz+zip',
  pdf: 'application/pdf',
};

/** The content type to upload a file as. Null when it cannot be told. */
export function contentTypeOf(file: { readonly name: string; readonly type: string }): string | null {
  const given = file.type.trim().toLowerCase();
  if (given !== '' && given !== 'application/octet-stream') {
    return given;
  }
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase();
  return extension === undefined ? null : (TYPES_BY_EXTENSION[extension] ?? null);
}

/**
 * The kind a content type belongs to, by the rule the API holds
 * (`TYPES_BY_KIND` in `apps/api/src/media/routes.ts`). Null for a type the
 * library does not take.
 */
export function kindOf(contentType: string): MediaKind | null {
  const topLevel = contentType.split('/')[0];
  switch (topLevel) {
    case 'image':
    case 'audio':
    case 'video':
    case 'model':
      return topLevel;
    case 'application':
    case 'text':
      return 'document';
    default:
      return null;
  }
}

/** A file's name without its extension: what the library shows it as at first. */
export function nameFromFile(fileName: string): string {
  const stem = fileName.replace(/\.[^.]*$/, '').trim();
  return stem === '' ? fileName.trim() : stem;
}

/** A size a person can read: `734 KB`, `12.4 MB`. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return '—';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** The files a mission may be given: the ready ones. */
export function placeable(items: readonly LibraryItem[]): readonly LibraryItem[] {
  return items.filter((item) => item.status === 'ready');
}

/** The calls, bound to a request function. */
export function mediaLibraryApi(request: Request, fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {
  return {
    async list(kind?: MediaKind): Promise<readonly LibraryItem[]> {
      const query = kind === undefined ? '' : `?kind=${encodeURIComponent(kind)}`;
      const answer = await request<{ media: LibraryItem[] }>(`/media/library${query}`);
      return answer.media;
    },

    /**
     * All three steps. `onStep` is told which one is running, so the screen
     * can say so. A failure part way leaves a pending file in the list, which
     * can be finished or removed.
     */
    async upload(
      file: Blob & { readonly name: string },
      details: { readonly name: string; readonly altText: string },
      onStep: (step: 'signing' | 'uploading' | 'checking') => void = () => {},
    ): Promise<LibraryItem> {
      const contentType = contentTypeOf(file);
      const kind = contentType === null ? null : kindOf(contentType);
      if (contentType === null || kind === null) {
        throw new Error('The library takes images, audio, video, PDFs and 3D models (.glb, .gltf, .usdz).');
      }

      onStep('signing');
      const grant = await request<UploadGrant>('/media/library', {
        method: 'POST',
        body: JSON.stringify({
          kind,
          contentType,
          name: details.name.trim(),
          ...(details.altText.trim() === '' ? {} : { altText: details.altText.trim() }),
        }),
      });

      onStep('uploading');
      let put: Response;
      try {
        put = await fetchImpl(grant.upload.url, {
          method: grant.upload.method,
          headers: grant.upload.headers,
          body: file,
        });
      } catch {
        throw new Error('The file could not be sent to storage. Check the connection and try again.');
      }
      if (!put.ok) {
        throw new Error(`Storage refused the file (${put.status}).`);
      }

      onStep('checking');
      return this.complete(grant.media.id);
    },

    async complete(id: string): Promise<LibraryItem> {
      const answer = await request<{ media: LibraryItem }>(
        `/media/library/${encodeURIComponent(id)}/complete`,
        { method: 'POST' },
      );
      return answer.media;
    },

    async update(id: string, change: { readonly name?: string; readonly altText?: string }): Promise<LibraryItem> {
      const answer = await request<{ media: LibraryItem }>(`/media/library/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(change),
      });
      return answer.media;
    },

    async remove(id: string): Promise<void> {
      await request<null>(`/media/library/${encodeURIComponent(id)}`, { method: 'DELETE' });
    },

    /** A short-lived URL to show or download the file with (EXPD-021). */
    async downloadUrl(id: string): Promise<string> {
      const answer = await request<{ download: { url: string } }>(`/media/${encodeURIComponent(id)}/download`);
      return answer.download.url;
    },
  };
}

/** The calls. */
export type MediaLibraryApi = ReturnType<typeof mediaLibraryApi>;
