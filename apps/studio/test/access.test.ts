import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Principal } from '@explorer/shared-types';

import { hasStudioAccess } from '../src/auth/access.ts';
import { principal } from './support.ts';

test('a platform admin is on the Explorer team', () => {
  assert.equal(hasStudioAccess(principal('org-a', true)), true);
});

test('an organisation admin is not, however much they may do inside their organisation', () => {
  const orgAdmin = { ...principal('org-a', false), orgRole: 'org-admin' } as Principal;
  assert.equal(hasStudioAccess(orgAdmin), false);
});

test('a creator is not', () => {
  assert.equal(hasStudioAccess(principal('org-a', false)), false);
});

test('a student phone is not', () => {
  const device = {
    kind: 'device',
    participantId: 'p',
    participantDeviceId: 'd',
    expeditionSessionId: 's',
    organisationId: 'org-a',
  } as unknown as Principal;
  assert.equal(hasStudioAccess(device), false);
});
