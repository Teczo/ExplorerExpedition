/**
 * The two ways a run judges what a team hands in.
 *
 * `scripted` is the default and the one the AI builder uses: stand-in mission
 * types whose behaviour reads the intended outcome straight out of the
 * submission, so an expedition can be played before anybody has built a
 * single mission type for it.
 *
 * `behaviour` is the one a test of a real mission type wants: the registry's
 * own code judges, and somebody has to hand it a payload it can judge.
 *
 * What is tested here is that both go through the same door. Whichever way a
 * run is judged, the verdict comes out of `completeMission` and the mission
 * state comes out of the transition table, so a run can never pass where the
 * platform would fail.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMissionTypeRegistry } from '../../src/mission-types/index.ts';
import {
  SCRIPTED_OUTCOME_FIELD,
  scriptedRegistryFor,
  simulateExpedition,
  simulatedTeam,
  type SimulatedPlayer,
} from '../../src/simulation/index.ts';
import { wordHunt, shelfTidy } from '../support/mission-types.ts';
import { missionId, rulesOf, straightLine } from './support.ts';

/** An expedition whose three missions are all word hunts. */
function hunts(): ReturnType<typeof straightLine> {
  return straightLine({
    missions: {
      missionTypeId: 'word-hunt',
      missionTypeVersion: '1.0.0',
      config: { words: ['gate', 'oak'], caseSensitive: false },
    },
  });
}

/** Somebody who knows the answer, and gets it wrong on purpose when told to. */
const wordHuntPlayer: SimulatedPlayer = ({ mission, intent }) => {
  const words = Array.isArray(mission.config['words']) ? mission.config['words'] : [];
  return { found: intent === 'correct' ? words : [] };
};

describe('a scripted run', () => {
  it('builds one stand-in for each type the document names', () => {
    const built = scriptedRegistryFor(hunts());

    assert.deepEqual(built.refs, ['word-hunt@1.0.0']);
    assert.deepEqual(built.unusable, []);
    assert.equal(built.registry.size, 1);
  });

  it('keeps a key the platform could never hold out of the registry', () => {
    const built = scriptedRegistryFor(straightLine({ missions: { missionTypeId: 'Not A Key' } }));

    assert.deepEqual(built.refs, []);
    assert.deepEqual(built.unusable, ['Not A Key@1.0.0']);
  });

  it('judges by the outcome the team meant, not by the settings', () => {
    const always = simulateExpedition({
      definition: hunts(),
      teams: [simulatedTeam('able', { skill: 1, givesUp: 0 })],
      seed: 'scripted',
    });
    const never = simulateExpedition({
      definition: hunts(),
      teams: [simulatedTeam('unable', { skill: 0, givesUp: 0, paceSeconds: 60 })],
      seed: 'scripted',
      limits: { maxStepsPerTeam: 30 },
    });

    assert.equal(always.teams[0]?.completedMissionIds.length, 3);
    assert.equal(never.teams[0]?.completedMissionIds.length, 0);
  });

  it('writes the intent into the payload and nothing else', () => {
    const built = scriptedRegistryFor(hunts());
    const behaviour = built.registry.behaviourFor('word-hunt', '1.0.0');

    assert.equal(
      behaviour?.evaluate({
        config: {},
        prepared: undefined,
        submission: { [SCRIPTED_OUTCOME_FIELD]: 'correct' },
        attemptNumber: 1,
      }).outcome,
      'correct',
    );
    assert.equal(
      behaviour?.evaluate({
        config: {},
        prepared: undefined,
        submission: { [SCRIPTED_OUTCOME_FIELD]: 'incorrect' },
        attemptNumber: 1,
      }).outcome,
      'incorrect',
    );
  });

  it('never needs a registry of its own', () => {
    const report = simulateExpedition({ definition: hunts(), teamCount: 1, seed: 'none' });

    assert.equal(report.judging, 'scripted');
    assert.equal(report.playable, true);
  });
});

describe('a run judged by real behaviour', () => {
  it('refuses to start without a registry to judge with', () => {
    assert.throws(
      () => simulateExpedition({ definition: hunts(), judging: 'behaviour' }),
      /needs a mission type registry/,
    );
  });

  it('lets a mission type judge a payload its own player wrote', () => {
    const report = simulateExpedition({
      definition: hunts(),
      judging: 'behaviour',
      registry: createMissionTypeRegistry([wordHunt]),
      players: { 'word-hunt': wordHuntPlayer },
      teams: [simulatedTeam('able', { skill: 1, givesUp: 0 })],
      seed: 'behaviour',
    });

    assert.equal(report.judging, 'behaviour');
    assert.deepEqual(report.teams[0]?.completedMissionIds, [
      missionId('alpha'),
      missionId('bravo'),
      missionId('charlie'),
    ]);
    assert.deepEqual(report.findings, []);
  });

  it('fails every mission when the player hands in the wrong answer', () => {
    const report = simulateExpedition({
      definition: hunts(),
      judging: 'behaviour',
      registry: createMissionTypeRegistry([wordHunt]),
      players: { 'word-hunt': wordHuntPlayer },
      teams: [simulatedTeam('unable', { skill: 0, givesUp: 0 })],
      seed: 'behaviour',
      limits: { maxStepsPerTeam: 30 },
    });

    assert.deepEqual(report.teams[0]?.completedMissionIds, []);
  });

  it('says when a type was played against a payload built from its schema', () => {
    const report = simulateExpedition({
      definition: hunts(),
      judging: 'behaviour',
      registry: createMissionTypeRegistry([wordHunt]),
      teamCount: 1,
      seed: 'sampled',
      limits: { maxStepsPerTeam: 30 },
    });
    const note = report.findings.find((finding) => finding.code === 'sampled-mission-type');

    assert.equal(note?.severity, 'note');
    assert.equal(note.missionTypeRef, 'word-hunt@1.0.0');
  });

  it('says nothing about a type that has no code to play against', () => {
    // A type an organisation built in the Studio is a row and nothing more,
    // so a teacher decides every submission and no player could have helped.
    const report = simulateExpedition({
      definition: straightLine({
        missions: {
          missionTypeId: 'shelf-tidy',
          missionTypeVersion: '1.0.0',
          config: { shelf: 'the one by the door' },
        },
        rules: rulesOf({ progression: 'open' }),
      }),
      judging: 'behaviour',
      registry: createMissionTypeRegistry([shelfTidy]),
      teamCount: 1,
      seed: 'studio-type',
    });

    assert.ok(!report.findings.some((finding) => finding.code === 'sampled-mission-type'));
    assert.equal(report.teams[0]?.finished, true);
  });
});
