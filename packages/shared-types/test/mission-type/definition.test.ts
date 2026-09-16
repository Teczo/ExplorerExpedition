/**
 * Checking that a mission type is one the platform can run.
 *
 * A type is checked once, when it is registered or saved. Every mission built
 * on it afterwards trusts that check, so what these tests hold to account is
 * that nothing gets past it: not a key the database would refuse, not a
 * schema the validator cannot run, and not a set of starting settings that
 * fail the type's own schema.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  MISSION_CAPABILITIES,
  MISSION_TYPE_STATUSES,
  isMissionCapability,
  isMissionTypeKey,
  missionTypeRef,
  validateMissionTypeDefinition,
  type MissionConfigIssue,
  type MissionTypeDefinition,
} from '../../src/mission-type/index.ts';

/** A mission type with nothing wrong with it, to change one thing at a time. */
function soundType(): MissionTypeDefinition {
  return {
    key: 'qr-hunt',
    version: '1.0.0',
    name: 'QR hunt',
    description: 'Teams find and scan codes hidden around a site.',
    status: 'published',
    capabilities: ['camera', 'qr'],
    configSchema: {
      type: 'object',
      properties: {
        codes: { type: 'array', items: { type: 'string', minLength: 1 }, minItems: 1 },
        order: { type: 'string', enum: ['any', 'in-order'] },
      },
      required: ['codes'],
    },
    submissionSchema: {
      type: 'object',
      properties: { scanned: { type: 'string', minLength: 1 } },
      required: ['scanned'],
    },
    defaultConfig: { codes: ['CHANGE-ME'], order: 'any' },
  };
}

function issuesOf(value: unknown): MissionConfigIssue[] {
  const result = validateMissionTypeDefinition(value);
  assert.equal(result.valid, false, 'expected the mission type to be refused');
  return result.valid ? [] : result.issues;
}

function onlyIssue(value: unknown): MissionConfigIssue {
  const issues = issuesOf(value);
  assert.equal(issues.length, 1, `expected one issue, got ${JSON.stringify(issues)}`);
  return issues[0] as MissionConfigIssue;
}

describe('a mission type the platform can run', () => {
  it('accepts a sound one', () => {
    assert.equal(validateMissionTypeDefinition(soundType()).valid, true);
  });

  it('accepts one that describes nothing yet, the way a new row does', () => {
    assert.equal(
      validateMissionTypeDefinition({
        key: 'work-in-progress',
        version: '0.1.0',
        name: 'Work in progress',
        description: '',
        status: 'draft',
        capabilities: [],
        configSchema: {},
        submissionSchema: {},
        defaultConfig: {},
      }).valid,
      true,
    );
  });

  it('refuses something that is not an object', () => {
    assert.equal(onlyIssue('qr-hunt').code, 'not-an-object');
  });
});

describe('the key and the version', () => {
  it('accepts the keys the database column accepts', () => {
    for (const key of ['qr-hunt', 'photo', 'a1', 'teacher-verification-2']) {
      assert.equal(isMissionTypeKey(key), true, key);
    }
  });

  it('refuses the keys the database column refuses', () => {
    for (const key of ['QR-Hunt', 'qr_hunt', '-qr', 'qr-', 'qr--hunt', '', 'qr hunt']) {
      assert.equal(isMissionTypeKey(key), false, key);
    }
  });

  it('reports a badly shaped key at the key', () => {
    const issue = onlyIssue({ ...soundType(), key: 'QR Hunt' });
    assert.equal(issue.code, 'pattern-mismatch');
    assert.equal(issue.path, 'key');
  });

  it('refuses a version that is not three whole numbers', () => {
    for (const version of ['1.0', '1.0.0-beta', 'v1.0.0', '1']) {
      const issue = onlyIssue({ ...soundType(), version });
      assert.equal(issue.code, 'pattern-mismatch', version);
      assert.equal(issue.path, 'version');
    }
  });

  it('says a key and a version out loud the same way everywhere', () => {
    assert.equal(missionTypeRef('qr-hunt', '1.2.0'), 'qr-hunt@1.2.0');
  });
});

describe('the descriptive fields', () => {
  it('needs a name an author can recognise', () => {
    assert.equal(onlyIssue({ ...soundType(), name: '   ' }).code, 'empty-string');
    assert.equal(onlyIssue({ ...soundType(), name: undefined }).code, 'empty-string');
  });

  it('takes an empty description but not a missing one', () => {
    assert.equal(validateMissionTypeDefinition({ ...soundType(), description: '' }).valid, true);
    assert.equal(onlyIssue({ ...soundType(), description: undefined }).code, 'wrong-type');
  });

  it('takes only the three statuses the database has', () => {
    for (const status of MISSION_TYPE_STATUSES) {
      assert.equal(validateMissionTypeDefinition({ ...soundType(), status }).valid, true, status);
    }
    assert.equal(onlyIssue({ ...soundType(), status: 'retired' }).code, 'not-allowed-value');
  });
});

describe('what the type needs from a device', () => {
  it('takes every capability the platform knows', () => {
    assert.equal(
      validateMissionTypeDefinition({
        ...soundType(),
        capabilities: [...MISSION_CAPABILITIES],
      }).valid,
      true,
    );
  });

  it('refuses a word that is not one of them', () => {
    const issue = onlyIssue({ ...soundType(), capabilities: ['camera', 'bluetooth'] });
    assert.equal(issue.code, 'not-allowed-value');
    assert.equal(issue.path, 'capabilities[1]');
  });

  it('refuses the same capability twice', () => {
    assert.equal(
      onlyIssue({ ...soundType(), capabilities: ['qr', 'qr'] }).code,
      'duplicate-item',
    );
  });

  it('knows a capability when it sees one', () => {
    assert.equal(isMissionCapability('qr'), true);
    assert.equal(isMissionCapability('nfc'), false);
    assert.equal(isMissionCapability(3), false);
  });
});

describe('the two schemas', () => {
  it('refuses a config schema the platform cannot run, and says where', () => {
    const issue = onlyIssue({
      ...soundType(),
      configSchema: { type: 'object', properties: { codes: { anyOf: [] } } },
    });
    assert.equal(issue.code, 'unsupported-keyword');
    assert.equal(issue.path, 'configSchema.properties.codes.anyOf');
  });

  it('refuses a submission schema the same way', () => {
    const issue = onlyIssue({ ...soundType(), submissionSchema: { type: 'wormhole' } });
    assert.equal(issue.path, 'submissionSchema.type');
  });

  it('needs both, even when they describe nothing', () => {
    assert.equal(onlyIssue({ ...soundType(), submissionSchema: undefined }).code, 'missing');
  });
});

describe('the settings a new mission starts with', () => {
  it('refuses starting settings that fail the type its own schema', () => {
    const issue = onlyIssue({ ...soundType(), defaultConfig: { codes: [] } });
    assert.equal(issue.code, 'too-short');
    assert.equal(issue.path, 'defaultConfig.codes');
  });

  it('refuses a starting setting the schema does not describe', () => {
    const issue = onlyIssue({
      ...soundType(),
      defaultConfig: { codes: ['A'], oder: 'any' },
    });
    assert.equal(issue.code, 'unknown-field');
    assert.equal(issue.path, 'defaultConfig.oder');
  });

  it('refuses starting settings that are not an object', () => {
    assert.equal(onlyIssue({ ...soundType(), defaultConfig: [] }).code, 'not-an-object');
  });

  it('does not check them against a schema it already refused', () => {
    // One problem, not two. A schema that could not be read cannot be used to
    // judge the defaults, and saying so twice would send an author chasing a
    // second problem that does not exist.
    const issue = onlyIssue({
      ...soundType(),
      configSchema: { type: 'object', properties: { codes: { anyOf: [] } } },
      defaultConfig: { anything: true },
    });
    assert.equal(issue.code, 'unsupported-keyword');
  });
});

describe('reporting more than one problem', () => {
  it('reports them all, so an author fixes the type once', () => {
    const issues = issuesOf({
      key: 'QR Hunt',
      version: '1.0',
      name: '',
      description: 'ok',
      status: 'published',
      capabilities: ['sonar'],
      configSchema: {},
      submissionSchema: {},
      defaultConfig: {},
    });
    assert.deepEqual(
      issues.map((issue) => issue.path),
      ['key', 'version', 'name', 'capabilities[0]'],
    );
  });
});
