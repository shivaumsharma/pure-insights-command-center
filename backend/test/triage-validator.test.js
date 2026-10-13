// The validator is the safety mechanism of the whole AI feature, so it is tested hardest: a corpus of hand-built hallucinations and
// mistakes, each of which it must catch with the right verdict and the right reason, plus the true suggestions it must NOT flag.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS, validateSuggestion } from '../src/triage/validator.js';
import { HALLUCINATIONS, mutate } from './helpers/triage-corpus.js';
import { cite, good, pack } from './helpers/triage-fixtures.js';

const ev = pack();
const codes = (r) => r.findings.map((f) => f.code);
const clone = (x) => structuredClone(x);

test('a true, fully cited suggestion is TRUSTED with no findings', () => {
  const r = validateSuggestion(good(), ev);
  assert.equal(r.status, STATUS.TRUSTED);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.supported_causes.sort(), ['HIGH_QUERY_VOLUME', 'RECURRING_SLOWNESS']);
});

for (const [name, breakIt, status, code] of HALLUCINATIONS) {
  test(`catches: ${name}`, () => {
    const r = validateSuggestion(mutate(breakIt), ev);
    assert.equal(r.status, status, JSON.stringify(r.findings.map((f) => f.code)));
    assert.ok(codes(r).includes(code), `expected ${code}, got ${codes(r).join(', ')}`);
  });
}

test('subtle misreadings are mismatches too: 41.3 for 41.2, 21001 for 21000, 15.1 for 15', () => {
  for (const [evidenceId, field, wrong] of [['O1', 'avg_load_time_sec', '41.3'], ['O1', 'query_count_last_30d', '21001'], ['O1', 'query_count_last_30d', '20999.9'], ['F', 'latency_threshold_sec', '15.1'], ['F', 'median_load_time_sec', '27.5']]) {
    const s = mutate((x) => { x.causes[0].cites.push(cite(evidenceId, field, wrong)); });
    const r = validateSuggestion(s, ev);
    assert.equal(r.status, STATUS.REJECTED, `${evidenceId}.${field} = ${wrong}`);
    assert.ok(codes(r).includes('VALUE_MISMATCH'));
  }
});

test('the corpus is large enough to mean something, and covers both verdicts', () => {
  assert.ok(HALLUCINATIONS.length >= 25);
  assert.ok(HALLUCINATIONS.some((h) => h[2] === 'REJECTED') && HALLUCINATIONS.some((h) => h[2] === 'NEEDS_REVIEW'));
});

test('garbage that is not a suggestion at all is rejected, never crashes', () => {
  for (const junk of [null, undefined, 'a string', 42, [], {}, { summary: 'x' }, { ...good(), causes: 'none' }, { ...good(), needs_human: 'yes' }]) {
    const r = validateSuggestion(junk, ev);
    assert.equal(r.status, STATUS.REJECTED);
    assert.equal(r.findings[0].code, 'SCHEMA_INVALID');
    assert.equal(r.suggestion, null);
  }
});

test('an error outranks a review: a fabricated citation plus an untestable cause is REJECTED, and both are reported', () => {
  const s = mutate((x) => { x.causes[0].cites[0].evidence = 'O99'; x.causes.push({ kind: 'OTHER', claim: 'Unknown.', cites: [], confidence: 0.2 }); });
  const r = validateSuggestion(s, ev);
  assert.equal(r.status, STATUS.REJECTED);
  assert.ok(codes(r).includes('UNKNOWN_EVIDENCE') && codes(r).includes('OTHER_UNVERIFIABLE'));
});

test('things that are fine must not be flagged (false-positive guards)', () => {
  // numbers rounded to the displayed precision are the same fact, not an invention
  let s = mutate((x) => { x.summary = 'Load time on RPT_9 was 41 s against the 15 s limit.'; });
  assert.equal(validateSuggestion(s, ev).status, STATUS.TRUSTED);
  // a numeric value written with a trailing zero is the same number
  s = mutate((x) => { x.causes[0].cites[0].value = '21000.0'; });
  assert.equal(validateSuggestion(s, ev).status, STATUS.TRUSTED);
  // booleans are compared as booleans
  s = mutate((x) => { x.causes[1].cites.push(cite('R', 'owner_on_record_at_alert', true)); });
  assert.equal(validateSuggestion(s, ev).status, STATUS.TRUSTED);
  // small derived counts ("4 of the latest 5") are not "invented numbers"
  assert.ok(!codes(validateSuggestion(good(), ev)).includes('UNSUPPORTED_NUMBER'));
  // report ids contain digits but are not numbers
  s = mutate((x) => { x.summary = 'RPT_9 was slow. See reading RPT_9:012 and O1.'; });
  assert.equal(validateSuggestion(s, ev).status, STATUS.TRUSTED);
  // recommending to simply watch it needs no justification
  s = mutate((x) => { x.actions = [{ kind: 'MONITOR', rationale: 'Keep an eye on it.', cites: [] }]; });
  assert.equal(validateSuggestion(s, ev).status, STATUS.TRUSTED);
});

test('a cause the evidence cannot decide (missing data) is sent to review, not guessed', () => {
  const thin = pack({ F: null });
  const r = validateSuggestion(good(), thin);
  assert.equal(r.status, STATUS.REJECTED); // citing F.* when F does not exist is fabrication
  assert.ok(codes(r).includes('UNKNOWN_EVIDENCE'));

  const noPeers = pack({ F: { p75_query_count_last_30d: undefined } });
  delete noPeers.items.F.fields.p75_query_count_last_30d;
  const s = mutate((x) => { x.causes = [{ kind: 'HIGH_QUERY_VOLUME', claim: 'Many queries.', cites: [cite('O1', 'query_count_last_30d', 21000)], confidence: 0.5 }]; x.actions = []; x.confidence = 0.5; });
  const r2 = validateSuggestion(s, noPeers);
  assert.equal(r2.status, STATUS.NEEDS_REVIEW);
  assert.ok(codes(r2).includes('EVIDENCE_MISSING'));
});

test('findings are reported once each, say where they are, and do not repeat', () => {
  const s = mutate((x) => { x.causes[0].cites.push(clone(x.causes[0].cites[0])); x.causes[0].cites.forEach((c) => { c.value = '1'; }); });
  const r = validateSuggestion(s, ev);
  const where = r.findings.filter((f) => f.code === 'VALUE_MISMATCH').map((f) => f.where);
  assert.equal(new Set(where).size, where.length);
  assert.ok(where.every((w) => /^causes\[0\]\.cites\[\d\]$/.test(w)));
});
