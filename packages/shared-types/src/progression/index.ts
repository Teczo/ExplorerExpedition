/**
 * The progression vocabulary (EXPD-013).
 *
 * What an expedition looks like to one team: the stops they have reached, the
 * missions they may work on, the ones they are shown, and what is holding the
 * rest up.
 *
 * Everything here is data. The rules — which unlock condition holds, which
 * stop a team may walk past, which edges a team's route lets them take — are
 * the progression engine in `@explorer/engine`, because those are game rules.
 *
 * The split is the same one the mission state vocabulary (EXPD-010) makes,
 * and for the same reason: the mission board shows a locked mission on every
 * screen and depends on this package alone.
 *
 * Where to look:
 *
 *   `snapshot.ts`  What the expedition comes to for one team, right now.
 *   `event.ts`     One change to that, written down as it happens (EXPD-014).
 */

export * from './snapshot.ts';
export * from './event.ts';
