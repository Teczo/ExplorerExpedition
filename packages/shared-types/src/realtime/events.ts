/**
 * What the realtime channel carries (EXPD-023).
 *
 * One run has one channel. Everything on it is a notice that something the
 * REST API already wrote has changed: the channel is never the record, and
 * nothing here can be sent the other way. A client that misses a notice —
 * a phone in a tunnel, a laptop that went to sleep — reconnects, is sent
 * `channel.ready`, and reads what it needs again over REST.
 *
 * Three sides read this list: the API sends it, the student app (EXPD-047)
 * and Director Mode (EXPD-055) receive it. That is why it lives here and not
 * in the API.
 *
 * **Who hears what.** Every event goes to an audience, and the API decides
 * the audience, not the client:
 *
 *   | Event                       | Staff | The team's phones | Every phone in the run |
 *   | --------------------------- | ----- | ----------------- | ---------------------- |
 *   | `session.status`            | yes   | yes               | yes                    |
 *   | `leaderboard.changed`       | yes   | yes               | yes                    |
 *   | `announcement`              | yes   | yes               | when sent to everybody |
 *   | `team.progress`             | yes   | yes               | no                     |
 *   | `mission.unlocked`          | yes   | yes               | no                     |
 *   | `team.roster-changed`       | yes   | no                | no                     |
 *   | `participant.team-changed`  | yes   | that phone only   | no                     |
 *   | `participant.removed`       | yes   | that phone only   | no                     |
 *
 * `leaderboard.changed` carries no figures. Who may see a board, and when,
 * differs between a teacher and a phone (EXPD-022), so the channel says the
 * board moved and the client reads `GET /sessions/:id/leaderboard`, which
 * applies those rules. A board that may not be shown yet still answers,
 * with `shown: false`.
 */

import type { MissionState } from '../mission-state/index.ts';
import type { SessionStatus } from '../participation/index.ts';

/**
 * A run's clock, as `GET /sessions/:id` answers with it (EXPD-019).
 *
 * Repeated here, field for field, because this package may not import from
 * the API.
 */
export interface RealtimeSessionClock {
  readonly now: string;
  readonly elapsedSeconds: number | null;
  readonly pausedSeconds: number;
  readonly limitSeconds: number | null;
  readonly remainingSeconds: number | null;
  readonly extendedSeconds: number;
  readonly endsAt: string | null;
  readonly expired: boolean;
  readonly endsOnTime: boolean;
}

/**
 * The first event on every connection. Staff are sent it again when the API
 * may have missed events; a phone's stream is closed instead, and the phone
 * reconnects.
 *
 * Nothing is replayed: the channel keeps no history. A client treats this
 * event as "whatever you drew before may be stale" and reads again.
 */
export interface ChannelReadyEvent {
  readonly type: 'channel.ready';
  readonly sessionStatus: SessionStatus;
  /** The team this connection hears, for a phone. Null for staff, and for a phone on no team. */
  readonly teamId: string | null;
  /** How often a comment line is sent to keep the connection open, in seconds. */
  readonly heartbeatSeconds: number;
}

/** A run was started, paused, resumed, extended or ended. */
export interface SessionStatusEvent {
  readonly type: 'session.status';
  readonly status: SessionStatus;
  readonly nextStatuses: readonly SessionStatus[];
  readonly clock: RealtimeSessionClock;
}

/** A team's score or a mission's state moved. */
export interface TeamProgressEvent {
  readonly type: 'team.progress';
  readonly teamId: string;
  /** The `MissionInstance.id` from the definition document. */
  readonly missionId: string;
  readonly missionState: MissionState;
  readonly totalScore: number;
  /** The points this change added or took away. Zero when the score did not move. */
  readonly scoreDelta: number;
  /** True once the team has finished the expedition. */
  readonly finished: boolean;
}

/** A change opened missions the team could not play before. */
export interface MissionUnlockedEvent {
  readonly type: 'mission.unlocked';
  readonly teamId: string;
  readonly missionIds: readonly string[];
}

/** Some team's score moved. Read the board again. */
export interface LeaderboardChangedEvent {
  readonly type: 'leaderboard.changed';
}

/** A team was made, or somebody joined, moved, left or was taken out. Staff only. */
export interface TeamRosterChangedEvent {
  readonly type: 'team.roster-changed';
  /** The student it was about, when it was about one. */
  readonly participantId: string | null;
  /** The team it was about, when it was about one. */
  readonly teamId: string | null;
}

/** This phone's student was put on a team, or taken off one. */
export interface ParticipantTeamChangedEvent {
  readonly type: 'participant.team-changed';
  readonly participantId: string;
  /** The team they are on now, or null for none. */
  readonly teamId: string | null;
}

/**
 * This phone's student was taken out of the run.
 *
 * The last event that phone is sent: the API closes the connection after it.
 */
export interface ParticipantRemovedEvent {
  readonly type: 'participant.removed';
  readonly participantId: string;
}

/** A teacher said something to the run, or to one team. */
export interface AnnouncementEvent {
  readonly type: 'announcement';
  readonly message: string;
  /** The team it was sent to, or null when it went to everybody. */
  readonly teamId: string | null;
}

/** Everything the channel can say. */
export type RealtimeEventBody =
  | ChannelReadyEvent
  | SessionStatusEvent
  | TeamProgressEvent
  | MissionUnlockedEvent
  | LeaderboardChangedEvent
  | TeamRosterChangedEvent
  | ParticipantTeamChangedEvent
  | ParticipantRemovedEvent
  | AnnouncementEvent;

/** The name of one kind of event. It is also the SSE `event:` field. */
export type RealtimeEventType = RealtimeEventBody['type'];

/** Every kind of event, in the order the table above lists them. */
export const REALTIME_EVENT_TYPES = [
  'channel.ready',
  'session.status',
  'leaderboard.changed',
  'announcement',
  'team.progress',
  'mission.unlocked',
  'team.roster-changed',
  'participant.team-changed',
  'participant.removed',
] as const satisfies readonly RealtimeEventType[];

/** One event, as it is sent: the body, and where and when it came from. */
export type RealtimeEvent = RealtimeEventBody & {
  /** Unique per event. Also the SSE `id:` field. */
  readonly id: string;
  readonly sessionId: string;
  /** When the API sent it. */
  readonly sentAt: string;
};
