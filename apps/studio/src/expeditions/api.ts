/**
 * The expedition endpoints, as the graph editor calls them (EXPD-026).
 *
 * The endpoints are EXPD-017's. Every call goes through
 * `AuthSession.request`, so it carries the bearer token and a 401 ends the
 * sign-in (EXPD-024).
 */

import { EXPEDITION_SCHEMA_VERSION, type JsonObject } from '@explorer/shared-types';

import type { Request } from '../mission-types/api.ts';
import { startingGraph } from './graph.ts';

/** One revision, without its document. */
export interface ExpeditionVersionView {
  readonly id: string;
  readonly definitionVersion: number;
  readonly status: 'draft' | 'published' | 'archived';
  readonly title: string;
  readonly updatedAt: string;
}

/** One expedition, as the list answers with it. */
export interface ExpeditionView {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly updatedAt: string;
  /** The revision being worked on, or null when the newest one is frozen. */
  readonly draft: ExpeditionVersionView | null;
  /** The newest frozen revision, or null while nothing has been published. */
  readonly published: ExpeditionVersionView | null;
}

/** One revision with its document, and what the API's check says about it. */
export interface ExpeditionDocumentView {
  readonly version: ExpeditionVersionView;
  readonly definition: JsonObject;
  readonly issues: readonly { path: string; message: string }[];
}

/** The API answers at most this many expeditions a page (EXPD-017). */
const PAGE = 100;

/** The calls, bound to a request function. */
export function expeditionApi(request: Request) {
  return {
    async list(): Promise<readonly ExpeditionView[]> {
      const answer = await request<{ expeditions: ExpeditionView[] }>(`/expeditions?limit=${PAGE}`);
      return answer.expeditions;
    },
    /** Creates one with a start and a finish, as revision 1. */
    create(title: string): Promise<ExpeditionDocumentView> {
      const definition = {
        schemaVersion: EXPEDITION_SCHEMA_VERSION,
        metadata: { title },
        missions: [],
        graph: startingGraph(),
      };
      return request<ExpeditionDocumentView>('/expeditions', {
        method: 'POST',
        body: JSON.stringify({ definition }),
      });
    },
    /**
     * The document to edit: the draft when there is one, otherwise the newest
     * published revision. Saving over a published one starts the next draft,
     * which is the API's rule, not this editor's.
     */
    open(expedition: ExpeditionView): Promise<ExpeditionDocumentView> {
      const id = encodeURIComponent(expedition.id);
      if (expedition.draft !== null) {
        return request<ExpeditionDocumentView>(`/expeditions/${id}/draft`);
      }
      const number = expedition.published?.definitionVersion ?? 1;
      return request<ExpeditionDocumentView>(`/expeditions/${id}/versions/${number}`);
    },
    saveDraft(id: string, definition: JsonObject): Promise<ExpeditionDocumentView> {
      return request<ExpeditionDocumentView>(`/expeditions/${encodeURIComponent(id)}/draft`, {
        method: 'PUT',
        body: JSON.stringify({ definition }),
      });
    },
  };
}

/** The calls. */
export type ExpeditionApi = ReturnType<typeof expeditionApi>;
