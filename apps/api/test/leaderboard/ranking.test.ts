/**
 * Placing teams in order (EXPD-022).
 *
 * `rankTeams` is a pure function, so these tests hand it figures and read
 * the places back. The config's promise is the thing under test: the higher
 * total first, then each tie break in the order the author named them, and
 * teams still equal after all of that share a place.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { rankTeams, type TeamFigures } from '../../src/leaderboard/ranking.ts';

function team(id: string, figures: Partial<TeamFigures> = {}): TeamFigures {
  return {
    teamId: id,
    teamName: id,
    totalScore: 0,
    missionsCompleted: 0,
    hintsUsed: 0,
    failedAttempts: 0,
    finishSeconds: null,
    ...figures,
  };
}

const places = (ranked: ReturnType<typeof rankTeams>): string[] =>
  ranked.map(({ rank, figures }) => `${String(rank)}:${figures.teamId}`);

describe('the total decides first', () => {
  test('the higher total is placed higher', () => {
    const ranked = rankTeams([team('a', { totalScore: 10 }), team('b', { totalScore: 30 }), team('c', { totalScore: 20 })], []);
    assert.deepEqual(places(ranked), ['1:b', '2:c', '3:a']);
  });

  test('a tie break never beats a higher total', () => {
    const ranked = rankTeams(
      [team('fast', { totalScore: 10, finishSeconds: 60 }), team('slow', { totalScore: 11, finishSeconds: 900 })],
      ['earliest-finish'],
    );
    assert.deepEqual(places(ranked), ['1:slow', '2:fast']);
  });

  test('a negative total is placed below nought', () => {
    const ranked = rankTeams([team('a', { totalScore: -5 }), team('b')], []);
    assert.deepEqual(places(ranked), ['1:b', '2:a']);
  });
});

describe('each tie break', () => {
  const level = { totalScore: 40 };

  test('earliest-finish: sooner is higher, and not finishing is lowest', () => {
    const ranked = rankTeams(
      [
        team('none', level),
        team('late', { ...level, finishSeconds: 900 }),
        team('early', { ...level, finishSeconds: 300 }),
      ],
      ['earliest-finish'],
    );
    assert.deepEqual(places(ranked), ['1:early', '2:late', '3:none']);
  });

  test('most-missions-completed: more is higher', () => {
    const ranked = rankTeams(
      [team('one', { ...level, missionsCompleted: 1 }), team('three', { ...level, missionsCompleted: 3 })],
      ['most-missions-completed'],
    );
    assert.deepEqual(places(ranked), ['1:three', '2:one']);
  });

  test('fewest-hints-used: fewer is higher', () => {
    const ranked = rankTeams(
      [team('many', { ...level, hintsUsed: 4 }), team('few', { ...level, hintsUsed: 1 })],
      ['fewest-hints-used'],
    );
    assert.deepEqual(places(ranked), ['1:few', '2:many']);
  });

  test('fewest-failed-attempts: fewer is higher', () => {
    const ranked = rankTeams(
      [team('many', { ...level, failedAttempts: 5 }), team('few', { ...level, failedAttempts: 0 })],
      ['fewest-failed-attempts'],
    );
    assert.deepEqual(places(ranked), ['1:few', '2:many']);
  });
});

describe('tie breaks are tried in the order named', () => {
  const a = team('a', { totalScore: 40, hintsUsed: 0, failedAttempts: 5 });
  const b = team('b', { totalScore: 40, hintsUsed: 2, failedAttempts: 1 });

  test('the first one that separates them decides', () => {
    assert.deepEqual(places(rankTeams([a, b], ['fewest-hints-used', 'fewest-failed-attempts'])), ['1:a', '2:b']);
    assert.deepEqual(places(rankTeams([a, b], ['fewest-failed-attempts', 'fewest-hints-used'])), ['1:b', '2:a']);
  });

  test('one that does not separate them passes to the next', () => {
    const c = team('c', { totalScore: 40, missionsCompleted: 2, hintsUsed: 3 });
    const d = team('d', { totalScore: 40, missionsCompleted: 2, hintsUsed: 1 });
    assert.deepEqual(
      places(rankTeams([c, d], ['most-missions-completed', 'fewest-hints-used'])),
      ['1:d', '2:c'],
    );
  });
});

describe('teams still level share a place', () => {
  test('with no tie breaks, an equal total is a shared place, and the next place is skipped', () => {
    const ranked = rankTeams(
      [team('b', { totalScore: 20 }), team('a', { totalScore: 20 }), team('c', { totalScore: 5 }), team('top', { totalScore: 99 })],
      [],
    );
    assert.deepEqual(places(ranked), ['1:top', '2:a', '2:b', '4:c']);
  });

  test('level after every tie break is still a shared place', () => {
    const ranked = rankTeams(
      [team('x', { totalScore: 10, hintsUsed: 1 }), team('y', { totalScore: 10, hintsUsed: 1 })],
      ['fewest-hints-used'],
    );
    assert.deepEqual(places(ranked), ['1:x', '1:y']);
  });

  test('the drawing order of a shared place is fixed, by name', () => {
    const one = rankTeams([team('zed', { teamName: 'Zed' }), team('amy', { teamName: 'Amy' })], []);
    const two = rankTeams([team('amy', { teamName: 'Amy' }), team('zed', { teamName: 'Zed' })], []);
    assert.deepEqual(places(one), places(two));
    assert.deepEqual(places(one), ['1:amy', '1:zed']);
  });

  test('no teams is an empty board', () => {
    assert.deepEqual(rankTeams([], ['earliest-finish']), []);
  });
});
