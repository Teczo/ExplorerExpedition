/**
 * The three things the harness brings that the engine does not have: a clock,
 * a generator, and a class of teams.
 *
 * They are tested on their own because everything else in a run rests on
 * them. A generator that drifts makes every other test here meaningless, and
 * a clock that steps backwards would make a run's own stream unreadable.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advanceClock,
  clockAt,
  createRandom,
  DEFAULT_SIMULATION_START,
  jitter,
  sampleValue,
  seedNumber,
  simulatedTeam,
  simulatedTeams,
  startClock,
} from '../../src/simulation/index.ts';
import { routeId } from './support.ts';

describe('the generator', () => {
  it('gives the same sequence for the same seed', () => {
    const first = createRandom('lake');
    const second = createRandom('lake');

    const left = Array.from({ length: 20 }, () => first.next());
    const right = Array.from({ length: 20 }, () => second.next());

    assert.deepEqual(left, right);
  });

  it('gives a different sequence for a different seed', () => {
    const left = Array.from({ length: 20 }, createRandom('lake').next);
    const right = Array.from({ length: 20 }, createRandom('hill').next);

    assert.notDeepEqual(left, right);
  });

  it('stays between nought and one', () => {
    const random = createRandom('anything');
    for (let index = 0; index < 500; index += 1) {
      const value = random.next();
      assert.ok(value >= 0 && value < 1, `${String(value)} is outside [0, 1)`);
    }
  });

  it('treats a probability outside nought and one as never and always', () => {
    const random = createRandom('dials');

    assert.equal(random.chance(-1), false);
    assert.equal(random.chance(0), false);
    assert.equal(random.chance(1), true);
    assert.equal(random.chance(2), true);
  });

  it('picks nothing out of nothing', () => {
    assert.equal(createRandom('empty').pick([]), undefined);
  });

  it('keeps a whole number inside the range it was given', () => {
    const random = createRandom('between');
    for (let index = 0; index < 200; index += 1) {
      const value = random.between(3, 7);
      assert.ok(Number.isInteger(value));
      assert.ok(value >= 3 && value <= 7);
    }
  });

  it('seeds the same string to the same number', () => {
    assert.equal(seedNumber('lake'), seedNumber('lake'));
    assert.notEqual(seedNumber('lake'), seedNumber('hill'));
  });

  it('spreads a figure either side of itself and never below nought', () => {
    const random = createRandom('jitter');
    for (let index = 0; index < 200; index += 1) {
      const value = jitter(random, 100, 0.25);
      assert.ok(value >= 75 && value <= 125, String(value));
    }
    assert.equal(jitter(random, 0, 0.5), 0);
    assert.equal(jitter(random, -10, 0.5), 0);
  });
});

describe('the clock', () => {
  it('starts where it was told to', () => {
    const clock = startClock();

    assert.equal(clock.startedAt, DEFAULT_SIMULATION_START);
    assert.equal(clock.elapsedSeconds, 0);
    assert.equal(clock.now, DEFAULT_SIMULATION_START);
  });

  it('moves forward by whole seconds', () => {
    const clock = advanceClock(advanceClock(startClock(), 90), 30);

    assert.equal(clock.elapsedSeconds, 120);
    assert.equal(clock.now, '2026-05-12T09:02:00.000Z');
  });

  it('never moves backwards', () => {
    const clock = advanceClock(startClock(), -600);

    assert.equal(clock.elapsedSeconds, 0);
    assert.equal(clock.now, DEFAULT_SIMULATION_START);
  });

  it('falls back rather than throwing on a start nobody can read', () => {
    assert.equal(clockAt('not a time', 60), DEFAULT_SIMULATION_START);
  });
});

describe('a class of teams', () => {
  it('brings the dials back into range rather than refusing them', () => {
    const team = simulatedTeam('over', { skill: 4, givesUp: -2, paceSeconds: -30 });

    assert.equal(team.skill, 1);
    assert.equal(team.givesUp, 0);
    assert.equal(team.paceSeconds, 180);
  });

  it('spreads a class from quick to slow', () => {
    const teams = simulatedTeams(3);
    const [quick, middle, slow] = teams;

    assert.equal(teams.length, 3);
    assert.ok(quick !== undefined && middle !== undefined && slow !== undefined);
    assert.ok(quick.skill > middle.skill);
    assert.ok(middle.skill > slow.skill);
    assert.ok(quick.paceSeconds < slow.paceSeconds);
  });

  it('makes a class of one the middling team exactly', () => {
    const [only] = simulatedTeams(1);

    assert.equal(only?.skill, simulatedTeam('x').skill);
    assert.equal(only?.paceSeconds, simulatedTeam('x').paceSeconds);
  });

  it('deals the routes out one team at a time and round again', () => {
    const teams = simulatedTeams(3, { routeIds: [routeId('water'), routeId('land')] });

    assert.deepEqual(
      teams.map((team) => team.routeIds),
      [['water'], ['land'], ['water']],
    );
  });

  it('builds the same class every time', () => {
    assert.deepEqual(simulatedTeams(5), simulatedTeams(5));
  });
});

describe('a payload built from a schema', () => {
  it('holds every required field and nothing else', () => {
    const made = sampleValue(
      {
        type: 'object',
        properties: {
          answer: { type: 'string' },
          confidence: { type: 'integer', minimum: 2, maximum: 9 },
          spare: { type: 'boolean' },
        },
        required: ['answer', 'confidence'],
      },
      createRandom('payload'),
    );

    assert.deepEqual(made, { answer: 'simulated', confidence: 2 });
  });

  it('honours the bounds a list sets', () => {
    const made = sampleValue(
      { type: 'array', minItems: 2, items: { type: 'string' }, uniqueItems: true },
      createRandom('payload'),
    );

    assert.deepEqual(made, ['simulated-0', 'simulated-1']);
  });

  it('takes a const or an enum over anything it would have made up', () => {
    const random = createRandom('payload');

    assert.equal(sampleValue({ const: 'fixed' }, random), 'fixed');
    assert.equal(sampleValue({ enum: ['only'] }, random), 'only');
  });

  it('pads a string out to the length the schema asks for', () => {
    const made = sampleValue({ type: 'string', minLength: 14 }, createRandom('payload'));

    assert.equal(typeof made, 'string');
    assert.equal((made as string).length, 14);
  });
});
