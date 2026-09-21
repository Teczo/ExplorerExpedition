/**
 * What the join, team and participant endpoints answer with (EXPD-018).
 *
 * A row is what PostgreSQL returned, snake case and all. A view is what a
 * client reads. This file is the one place the first becomes the second, the
 * way `expeditions/views.ts` is for EXPD-017, so that a column a migration
 * renames is a change in one file rather than in every handler.
 *
 * One rule here that the expedition views did not need: a student's display
 * name goes out to staff and to the student themselves, and to nobody else.
 * `toJoinView` is what a phone is answered with when it types a code, and it
 * carries that phone's own participant and the names of their teammates —
 * which they are about to spend an afternoon with — and not a list of
 * everybody in the school. What may be collected about a child at all is
 * EXPD-071.
 */

import {
  isJoinableSessionStatus,
  type ParticipantStatus,
  type SessionStatus,
  type TeamRules,
  type TeamStatus,
} from '@explorer/shared-types';

import type {
  ExpeditionSessionRow,
  ParticipantRow,
  TeamMemberRow,
  TeamRow,
} from '../repositories/rows.ts';
import { participantCapacityOf } from './team-rules.ts';

/** One student in a run, and where they are on the team sheet. */
export interface ParticipantView {
  readonly id: string;
  readonly displayName: string;
  readonly status: ParticipantStatus;
  /** The team they are on now, or null when they are on none. */
  readonly teamId: string | null;
  /** The role they hold on it, or null for no role. */
  readonly role: string | null;
  readonly isLeader: boolean;
  readonly joinedAt: string;
}

/** One member of a team, from the team's side. */
export interface TeamMemberView {
  readonly participantId: string;
  readonly displayName: string;
  readonly role: string | null;
  readonly isLeader: boolean;
  readonly joinedAt: string;
}

/** One team in a run, with who is on it. */
export interface TeamView {
  readonly id: string;
  readonly name: string;
  readonly status: TeamStatus;
  readonly members: readonly TeamMemberView[];
  readonly memberCount: number;
  /** How many more students this team may take, given the expedition's rules. */
  readonly placesLeft: number;
  readonly createdAt: string;
}

/** The limits a run plays by, and how much of each is used up. */
export interface TeamLimitsView {
  readonly size: { readonly min: number; readonly max: number };
  readonly maxTeams: number | null;
  readonly roles: readonly string[];
  readonly requireFullTeamToStart: boolean;
  /** How many students the run can hold in all, or null when it is uncapped. */
  readonly participantCapacity: number | null;
}

/** A run, as the team sheet needs to know it. */
export interface SessionSummaryView {
  readonly id: string;
  readonly name: string;
  readonly status: SessionStatus;
  readonly expeditionId: string;
  readonly expeditionVersionId: string;
}

/** The code a run is joined with. */
export interface JoinCodeView {
  readonly sessionId: string;
  readonly joinCode: string;
  readonly status: SessionStatus;
  /** False once a run has ended: the code no longer reaches it. */
  readonly joinable: boolean;
}

/** Every team in a run, and the limits they are held to. */
export interface TeamListView {
  readonly session: SessionSummaryView;
  readonly limits: TeamLimitsView;
  readonly teams: readonly TeamView[];
  /** How many more teams the run may have, or null when it is uncapped. */
  readonly placesLeft: number | null;
}

/** Every student in a run. */
export interface ParticipantListView {
  readonly session: SessionSummaryView;
  readonly limits: TeamLimitsView;
  readonly participants: readonly ParticipantView[];
  /** Students who are still in the run, whatever team they are on. */
  readonly presentCount: number;
}

/** What a phone is answered with when it types a code. */
export interface JoinView {
  readonly session: SessionSummaryView;
  readonly organisationId: string;
  readonly participant: ParticipantView;
  /** The team they are on, or null while they are still in the lobby. */
  readonly team: TeamView | null;
  /**
   * The credential the phone keeps.
   *
   * Returned once, at the moment it is minted, and never readable again: only
   * its hash is stored. The phone exchanges it for a short-lived access token
   * at `POST /auth/device/token` (EXPD-004).
   */
  readonly deviceToken: string;
  readonly deviceTokenExpiresAt: string;
}

/**
 * Turns a run into the code it is joined with.
 *
 * `joinable` is not a column. It is whether the run's status is one of the
 * four the unique index covers, which is the only thing that decides whether
 * typing the code reaches anything.
 */
export function toJoinCodeView(row: ExpeditionSessionRow): JoinCodeView {
  return {
    sessionId: row.id,
    joinCode: row.join_code,
    status: row.status,
    joinable: isJoinableSessionStatus(row.status),
  };
}

/** Turns a run into the little of it a team sheet needs. */
export function toSessionSummaryView(row: ExpeditionSessionRow): SessionSummaryView {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    expeditionId: row.expedition_id,
    expeditionVersionId: row.expedition_version_id,
  };
}

/** Turns the expedition's team rules into the shape a client reads. */
export function toTeamLimitsView(rules: TeamRules): TeamLimitsView {
  return {
    size: { min: rules.size.min, max: rules.size.max },
    maxTeams: rules.maxTeams,
    roles: [...rules.roles],
    requireFullTeamToStart: rules.requireFullTeamToStart,
    participantCapacity: participantCapacityOf(rules),
  };
}

/** Turns a student and their live membership into the shape a client reads. */
export function toParticipantView(
  row: ParticipantRow,
  membership: TeamMemberRow | null,
): ParticipantView {
  return {
    id: row.id,
    displayName: row.display_name,
    status: row.status,
    teamId: membership === null ? null : membership.team_id,
    role: membership === null ? null : membership.role,
    isLeader: membership !== null && membership.is_leader,
    joinedAt: timeOf(row.joined_at) ?? '',
  };
}

/**
 * Turns a team and its live members into the shape a client reads.
 *
 * `members` is every live membership of this team, and `names` says what each
 * of those students is called. A membership whose student is not in `names`
 * is left out rather than shown as a blank row: it can only happen when the
 * two reads raced, and a team sheet with a nameless line on it is worse than
 * one that is a moment out of date.
 */
export function toTeamView(
  row: TeamRow,
  members: readonly TeamMemberRow[],
  names: ReadonlyMap<string, string>,
  rules: TeamRules,
): TeamView {
  const views = members
    .filter((member) => names.has(member.participant_id))
    .map((member) => ({
      participantId: member.participant_id,
      displayName: names.get(member.participant_id) ?? '',
      role: member.role,
      isLeader: member.is_leader,
      joinedAt: timeOf(member.joined_at) ?? '',
    }));

  return {
    id: row.id,
    name: row.name,
    status: row.status,
    members: views,
    memberCount: views.length,
    placesLeft: Math.max(0, rules.size.max - views.length),
    createdAt: timeOf(row.created_at) ?? '',
  };
}

/**
 * A time as a client reads it.
 *
 * `pg` gives back a `Date` for a `timestamptz`, and `FakeDatabase` gives back
 * whatever a test seeded, which may already be a string, or nothing at all
 * where the real column has a default. All three are answered the same way
 * rather than one of them throwing — the same reasoning as
 * `expeditions/views.ts`.
 */
function timeOf(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : String(value);
}
