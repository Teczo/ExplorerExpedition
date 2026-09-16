/**
 * The promise the ticket makes: a new mission type needs no engine change.
 *
 * Two halves. First, that the engine's own source knows nothing about any
 * particular mission type — checked by reading it, because a `switch` on a
 * type key is exactly the thing that would creep back in. Second, that a type
 * invented right here, with a shape nothing in the engine has seen, works all
 * the way through: registered, configured, checked and evaluated.
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import type { JsonObject } from '@explorer/shared-types';

import {
  createMissionTypeRegistry,
  defineMissionType,
  type MissionTypeEntry,
} from '../src/mission-types/index.ts';

const ENGINE_SOURCE = fileURLToPath(new URL('../src', import.meta.url));

/** Every `.ts` file under the engine's source folder, with its text. */
function engineSources(directory = ENGINE_SOURCE): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...engineSources(path));
    } else if (entry.name.endsWith('.ts')) {
      found.push([path, readFileSync(path, 'utf8')]);
    }
  }
  return found;
}

describe('the engine knows nothing about any one mission type', () => {
  const sources = engineSources();

  // The eight types phase 1 ships, EXPD-032 to EXPD-039. None of their keys
  // may appear in engine source, in a list, a `switch` or an import.
  const keys = [
    'qr-hunt',
    'photo-evidence',
    'physical-challenge',
    'puzzle',
    'timed-challenge',
    'teacher-verification',
    'communication-challenge',
    'navigation',
  ];

  for (const key of keys) {
    it(`never names "${key}"`, () => {
      for (const [path, text] of sources) {
        // The ticket list in a doc comment is a reference, not a dependency.
        const code = text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
        assert.ok(
          !code.includes(key),
          `${path} names the mission type "${key}", so adding one is an engine change`,
        );
      }
    });
  }

  it('imports nothing outside the engine but the shared types', () => {
    for (const [path, text] of engineSources()) {
      for (const match of text.matchAll(/from '([^']+)'/g)) {
        const target = match[1] ?? '';
        assert.ok(
          target.startsWith('.') ||
            target === '@explorer/shared-types' ||
            target.startsWith('node:'),
          `${path} imports ${target}`,
        );
      }
    }
  });
});

/**
 * A mission type invented for this test alone.
 *
 * Nothing about it — its key, its settings, the shape of its submissions, the
 * way it decides — exists anywhere in the engine. If it works, a real one
 * will.
 */
const birdCount: MissionTypeEntry = defineMissionType({
  definition: {
    key: 'bird-count',
    version: '1.0.0',
    name: 'Count the birds',
    description: 'Teams count what they see and say how sure they are.',
    status: 'published',
    capabilities: ['camera', 'location'],
    configSchema: {
      type: 'object',
      properties: {
        expected: { type: 'integer', minimum: 0, maximum: 500 },
        tolerance: { type: 'integer', minimum: 0, maximum: 50 },
        askConfidence: { type: 'boolean' },
      },
      required: ['expected', 'tolerance'],
    },
    submissionSchema: {
      type: 'object',
      properties: {
        counted: { type: 'integer', minimum: 0 },
        confidence: { type: 'string', enum: ['sure', 'unsure'] },
      },
      required: ['counted'],
    },
    defaultConfig: { expected: 0, tolerance: 2, askConfidence: true },
  },
  behaviour: {
    prepare(config: JsonObject) {
      const expected = Number(config['expected'] ?? 0);
      const tolerance = Number(config['tolerance'] ?? 0);
      return { low: expected - tolerance, high: expected + tolerance };
    },
    evaluate({ prepared, submission }) {
      const band = prepared as { low: number; high: number };
      const counted = Number(submission['counted']);
      if (submission['confidence'] === 'unsure') {
        return { outcome: 'needs-review', detail: { counted } };
      }
      const close = counted >= band.low && counted <= band.high;
      return { outcome: close ? 'correct' : 'incorrect', progress: close ? 1 : 0 };
    },
  },
});

describe('a mission type nothing in the engine has seen', () => {
  const registry = createMissionTypeRegistry([birdCount]);

  it('registers with no change to anything', () => {
    assert.equal(registry.has('bird-count', '1.0.0'), true);
    assert.equal(registry.latest('bird-count')?.definition.name, 'Count the birds');
  });

  it('hands an author its starting settings', () => {
    assert.deepEqual(registry.defaultConfigFor('bird-count', '1.0.0'), {
      expected: 0,
      tolerance: 2,
      askConfidence: true,
    });
  });

  it('checks settings by its own rules', () => {
    assert.equal(
      registry.validateConfig('bird-count', '1.0.0', { expected: 12, tolerance: 3 }).valid,
      true,
    );
    const tooMany = registry.validateConfig('bird-count', '1.0.0', {
      expected: 900,
      tolerance: 3,
    });
    assert.equal(tooMany.valid, false);
    assert.equal(tooMany.valid === false && tooMany.issues[0]?.path, 'config.expected');
  });

  it('checks submissions by its own rules', () => {
    assert.equal(
      registry.validateSubmission('bird-count', '1.0.0', { counted: 11 }).valid,
      true,
    );
    assert.equal(
      registry.validateSubmission('bird-count', '1.0.0', { counted: 11, confidence: 'maybe' })
        .valid,
      false,
    );
  });

  it('says what a phone will be asked for', () => {
    assert.deepEqual(registry.get('bird-count', '1.0.0')?.definition.capabilities, [
      'camera',
      'location',
    ]);
  });

  it('prepares a config once, and judges submissions against what it made', () => {
    const config = { expected: 12, tolerance: 3 };
    const prepared = registry.prepareConfig('bird-count', '1.0.0', config);
    assert.deepEqual(prepared, { low: 9, high: 15 });

    const behaviour = registry.behaviourFor('bird-count', '1.0.0');
    assert.notEqual(behaviour, undefined);

    const judge = (submission: JsonObject) =>
      behaviour?.evaluate({ config, prepared, submission, attemptNumber: 1 });

    assert.equal(judge({ counted: 13 })?.outcome, 'correct');
    assert.equal(judge({ counted: 30 })?.outcome, 'incorrect');
    assert.equal(judge({ counted: 13, confidence: 'unsure' })?.outcome, 'needs-review');
  });
});

describe('a mission type with no behaviour of its own', () => {
  const registry = createMissionTypeRegistry([
    { definition: { ...birdCount.definition, key: 'bird-count-by-hand' } },
  ]);

  it('is held, configured and checked all the same', () => {
    assert.equal(
      registry.validateConfig('bird-count-by-hand', '1.0.0', { expected: 1, tolerance: 0 })
        .valid,
      true,
    );
  });

  it('has nothing to prepare and nothing to judge with', () => {
    assert.equal(registry.behaviourFor('bird-count-by-hand', '1.0.0'), undefined);
    assert.equal(registry.prepareConfig('bird-count-by-hand', '1.0.0', {}), undefined);
  });
});
