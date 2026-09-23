/**
 * What each change tells the run (EXPD-023).
 *
 * One function per kind of change, each turning the answer a route already
 * gave into the notices that go on the channel. The routes call these after
 * their service returns, which is after the transaction committed.
 *
 * Kept apart from the routes so that what a change says, and to whom, is in
 * one file and can be tested without a socket.
 */

import type { PlayView } from '../play/views.ts';
import type { SessionView } from '../sessions/views.ts';
import type { Notice, RealtimeHub, RunTarget } from './hub.ts';

/** A run was started, paused, resumed, extended or ended. Everybody hears it. */
export function sessionChangedNotices(session: SessionView): Notice[] {
  return [
    {
      audience: { kind: 'everyone' },
      event: {
        type: 'session.status',
        status: session.status,
        nextStatuses: session.nextStatuses,
        clock: session.clock,
      },
    },
  ];
}

/**
 * A team started a try, handed work in, opened a hint, or had work decided.
 *
 * The team and staff hear where the mission is and what the score is. If the
 * change opened missions, they hear which. If the score moved, everybody is
 * told the board moved — without the figures, which the board's own
 * visibility rules decide who may see (EXPD-022).
 */
export function playedNotices(played: PlayView): Notice[] {
  const team = { kind: 'team', teamId: played.teamId } as const;
  const scoreDelta = played.score.events.reduce((sum, event) => sum + event.points, 0);

  const notices: Notice[] = [
    {
      audience: team,
      event: {
        type: 'team.progress',
        teamId: played.teamId,
        missionId: played.mission.id,
        missionState: played.mission.state,
        totalScore: played.score.total,
        scoreDelta,
        finished: played.progression.finished,
      },
    },
  ];

  const opened = [
    ...new Set(
      played.progression.events
        .filter((event) => event.reason === 'mission-unlocked' || event.reason === 'mission-revealed')
        .map((event) => event.missionInstanceId)
        .filter((id): id is NonNullable<typeof id> => id !== undefined),
    ),
  ];
  if (opened.length > 0) {
    notices.push({
      audience: team,
      event: { type: 'mission.unlocked', teamId: played.teamId, missionIds: opened },
    });
  }

  if (played.score.events.length > 0 || hasFinished(played)) {
    notices.push({ audience: { kind: 'everyone' }, event: { type: 'leaderboard.changed' } });
  }

  return notices;
}

/** Finishing moves a team up a board on `earliest-finish`, even with no points in it. */
function hasFinished(played: PlayView): boolean {
  return played.progression.events.some((event) => event.reason === 'expedition-finished');
}

/** A team was made. Staff redraw the team sheet. */
export function teamCreatedNotices(teamId: string): Notice[] {
  return [rosterChanged(null, teamId)];
}

/** A student joined the run. Staff redraw the team sheet. */
export function participantJoinedNotices(participantId: string, teamId: string | null): Notice[] {
  return [rosterChanged(participantId, teamId)];
}

/**
 * A student was put on a team, moved, or taken off one.
 *
 * Their own phone is told which team it is on now, and the hub moves the
 * phone's stream to that team's events from then on.
 */
export function participantTeamChangedNotices(
  participantId: string,
  teamId: string | null,
): Notice[] {
  return [
    rosterChanged(participantId, teamId),
    {
      audience: { kind: 'participant', participantId },
      event: { type: 'participant.team-changed', participantId, teamId },
    },
  ];
}

/** A student was taken out of the run. Their phone is told, and its stream is closed. */
export function participantRemovedNotices(participantId: string): Notice[] {
  return [
    rosterChanged(participantId, null),
    {
      audience: { kind: 'participant', participantId },
      event: { type: 'participant.removed', participantId },
    },
  ];
}

/** A teacher said something to the run, or to one team. */
export function announcementNotices(message: string, teamId: string | null): Notice[] {
  return [
    {
      audience: teamId === null ? { kind: 'everyone' } : { kind: 'team', teamId },
      event: { type: 'announcement', message, teamId },
    },
  ];
}

function rosterChanged(participantId: string | null, teamId: string | null): Notice {
  return {
    audience: { kind: 'staff' },
    event: { type: 'team.roster-changed', participantId, teamId },
  };
}

/**
 * Tells a run about a change, without waiting.
 *
 * What a route calls once its service has returned. The answer to the
 * request is not held up by Redis: the change is already committed, and a
 * publish that fails is logged by the hub. Does nothing when the app was
 * built without a hub.
 */
export function tellRun(
  hub: RealtimeHub | undefined,
  target: RunTarget,
  notices: readonly Notice[],
): void {
  if (hub !== undefined && notices.length > 0) {
    void hub.publish(target, notices);
  }
}
