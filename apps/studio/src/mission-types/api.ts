/**
 * The mission type endpoints, as the builder calls them (EXPD-025, EXPD-031).
 *
 * Every call goes through `AuthSession.request`, so it carries the bearer
 * token and a 401 ends the sign-in (EXPD-024).
 */

import type { AuthoredMissionType } from '@explorer/shared-types';

/** One mission type, as the API answers with it. */
export interface MissionTypeView extends AuthoredMissionType {
  readonly id: string;
  readonly owner: 'organisation' | 'platform';
  /** True for this organisation's own drafts, the only ones a save may change. */
  readonly editable: boolean;
  readonly createdBy: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What `AuthSession.request` looks like, so a test can pass its own. */
export type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

/** The calls, bound to a request function. */
export function missionTypeApi(request: Request) {
  return {
    async list(): Promise<readonly MissionTypeView[]> {
      const answer = await request<{ missionTypes: MissionTypeView[] }>('/mission-types');
      return answer.missionTypes;
    },
    get(id: string): Promise<MissionTypeView> {
      return request<MissionTypeView>(`/mission-types/${encodeURIComponent(id)}`);
    },
    create(missionType: AuthoredMissionType): Promise<MissionTypeView> {
      return request<MissionTypeView>('/mission-types', {
        method: 'POST',
        body: JSON.stringify({ missionType }),
      });
    },
    update(id: string, missionType: AuthoredMissionType): Promise<MissionTypeView> {
      return request<MissionTypeView>(`/mission-types/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify({ missionType }),
      });
    },
    /** Freezes a draft. Nothing changes it afterwards. */
    publish(id: string): Promise<MissionTypeView> {
      return request<MissionTypeView>(`/mission-types/${encodeURIComponent(id)}/publish`, {
        method: 'POST',
      });
    },
    /** Starts the next version of a published type, as a draft copied from it. */
    newVersion(id: string, version: string): Promise<MissionTypeView> {
      return request<MissionTypeView>(`/mission-types/${encodeURIComponent(id)}/versions`, {
        method: 'POST',
        body: JSON.stringify({ version }),
      });
    },
  };
}

/** The calls. */
export type MissionTypeApi = ReturnType<typeof missionTypeApi>;
