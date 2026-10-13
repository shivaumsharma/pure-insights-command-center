// "How it was checked": the validator's findings grouped into the questions a reader cares about.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CHECK_GROUPS, checklist } from '../src/triage/checks.js';

const finding = (code, severity = 'review') => ({ code, severity, message: 'x' });
const resultOf = (list, id) => list.find((c) => c.id === id).result;

test('with nothing found every check is OK, and each has a label a reader can understand', () => {
  const list = checklist([]);
  assert.equal(list.length, CHECK_GROUPS.length);
  assert.ok(list.every((c) => c.result === 'OK' && c.label.length > 15));
  assert.deepEqual(checklist(undefined).map((c) => c.result), list.map((c) => c.result));
});

test('a finding puts its group at UNVERIFIED (could not be checked) or FALSE (the data contradicts it), and leaves the others alone', () => {
  const list = checklist([finding('OTHER_UNVERIFIABLE', 'review')]);
  assert.equal(resultOf(list, 'causes'), 'UNVERIFIED');
  assert.equal(list.filter((c) => c.result !== 'OK').length, 1);
  assert.equal(resultOf(checklist([finding('VALUE_MISMATCH', 'error')]), 'cites'), 'FALSE');
});

test('FALSE beats UNVERIFIED within a group', () => {
  assert.equal(resultOf(checklist([finding('NO_CITATION', 'review'), finding('VALUE_MISMATCH', 'error')]), 'cites'), 'FALSE');
  assert.equal(resultOf(checklist([finding('VALUE_MISMATCH', 'error'), finding('NO_CITATION', 'review')]), 'cites'), 'FALSE');
});

test('a code the groups do not know still appears, under Other, so nothing the validator finds can go missing', () => {
  const list = checklist([finding('SOMETHING_NEW', 'error')]);
  assert.equal(list.at(-1).id, 'other');
  assert.equal(list.at(-1).result, 'FALSE');
  assert.equal(checklist([finding('SOMETHING_NEW', 'review')]).at(-1).result, 'UNVERIFIED');
});

test('every code the validator can raise belongs to exactly one group, so none ends up under Other', () => {
  const source = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/triage/validator.js'), 'utf8');
  const raised = [...new Set([...source.matchAll(/add\('([A-Z_]+)'/g)].map((m) => m[1]))];
  assert.ok(raised.length >= 15, `only ${raised.length} codes found in the validator; the pattern has broken`);
  const owners = (code) => CHECK_GROUPS.filter((g) => g.codes.includes(code)).map((g) => g.id);
  for (const code of raised) assert.equal(owners(code).length, 1, `${code} belongs to ${owners(code).length} groups`);
  const stray = CHECK_GROUPS.flatMap((g) => g.codes).filter((code) => !raised.includes(code));
  assert.deepEqual(stray, [], `groups list codes the validator never raises: ${stray.join(', ')}`);
});
