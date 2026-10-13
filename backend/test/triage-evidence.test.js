import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAlertEngine } from '../src/alerts/engine.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';
import { baselineTriager } from '../src/triage/baseline.js';
import { buildEvidence } from '../src/triage/evidence.js';
import { STATUS, validateSuggestion } from '../src/triage/validator.js';
import { pack } from './helpers/triage-fixtures.js';

const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-triage-')) });
const alertFor = (reportId, nth, extra = {}) => ({
  alert_type: 'LATENCY', lifecycle: 'TRIGGERED', severity: 'high', report_id: reportId, value: 41, threshold: 15,
  observation_id: store.observationHistory(reportId)[nth - 1].observation_id, ...extra,
});

test('evidence stops at the alert: later readings never leak into an explanation of an earlier alert', () => {
  const history = store.observationHistory('RPT_201');
  const ev = buildEvidence({ alert: alertFor('RPT_201', 4), store });
  assert.equal(ev.items.O1.fields.reading, history[3].observation_id); // the alert's own reading is the newest one
  assert.deepEqual(['O1', 'O2', 'O3', 'O4'], Object.keys(ev.items).filter((k) => /^O\d+$/.test(k)));
  assert.equal(ev.items.R.fields.readings_so_far, 4);
  const later = history.slice(4).map((o) => o.observation_id);
  for (const id of later) assert.ok(!JSON.stringify(ev).includes(id), `${id} is from after the alert`);
});

test('replayed alerts (ids shifted by "@c2") resolve to the same reading', () => {
  const plain = buildEvidence({ alert: alertFor('RPT_201', 6), store });
  const shifted = buildEvidence({ alert: alertFor('RPT_201', 6, { observation_id: `${alertFor('RPT_201', 6).observation_id}@c2` }), store });
  assert.deepEqual(shifted.items.O1, plain.items.O1);
  assert.equal(shifted.items.R.fields.readings_so_far, 6);
});

test('at most 8 readings are included, newest first', () => {
  const ev = buildEvidence({ alert: alertFor('RPT_201', 15), store });
  const ids = Object.keys(ev.items).filter((k) => /^O\d+$/.test(k));
  assert.equal(ids.length, 8);
  const history = store.observationHistory('RPT_201');
  assert.equal(ev.items.O1.fields.reading, history[14].observation_id);
  assert.equal(ev.items.O8.fields.reading, history[7].observation_id);
});

test('an unknown reading id falls back to the whole history rather than failing', () => {
  const ev = buildEvidence({ alert: alertFor('RPT_201', 3, { observation_id: 'RPT_201:999' }), store });
  assert.equal(ev.items.R.fields.readings_so_far, store.observationHistory('RPT_201').length);
});

test('no personal data, free text or cost reaches the evidence (so none can reach a model or a viewer)', () => {
  for (const n of [1, 5, 12, 20]) {
    const text = JSON.stringify(buildEvidence({ alert: alertFor('RPT_203', n), store }));
    assert.ok(!text.includes('@'), 'an email address');
    assert.ok(!/Analytics Dashboard|report_name/i.test(text), 'a report name');
    assert.ok(!/cost|credit|usd|price|\$/i.test(text), 'cost data');
    assert.ok(!/owner_email/.test(text), 'the owner email field');
  }
});

test('ownership is a yes/no fact as of the alert, taken from that reading', () => {
  const orphanReading = store.observations().find((o) => o.owner_email === null || o.owner_email === undefined);
  assert.ok(orphanReading, 'the data has an orphan reading');
  const history = store.observationHistory(orphanReading.report_id);
  const nth = history.findIndex((o) => o.observation_id === orphanReading.observation_id) + 1;
  const ev = buildEvidence({ alert: alertFor(orphanReading.report_id, nth), store });
  assert.equal(ev.items.R.fields.owner_on_record_at_alert, false);
  const owned = store.observations().find((o) => o.owner_email);
  const nth2 = store.observationHistory(owned.report_id).findIndex((o) => o.observation_id === owned.observation_id) + 1;
  assert.equal(buildEvidence({ alert: alertFor(owned.report_id, nth2), store }).items.R.fields.owner_on_record_at_alert, true);
});

test('fleet baselines match an independent calculation (nearest-rank percentiles)', () => {
  const f = buildEvidence({ alert: alertFor('RPT_201', 4), store }).items.F.fields;
  assert.equal(f.readings, 1976);
  assert.equal(f.p75_query_count_last_30d, 18898);
  assert.equal(f.p75_concurrent_user_peak, 112);
  assert.equal(f.slow_readings_pct, 74.4);
  assert.equal(f.latency_threshold_sec, 15);
  assert.equal(typeof f.median_load_time_sec, 'number');
});

// ------------------------------------------------------------------ the rule-based baseline

test('baseline on a worked example: the two supported causes, a justified action, and TRUSTED', async () => {
  const ev = pack();
  const { suggestion } = await baselineTriager.triage(ev);
  assert.deepEqual(suggestion.causes.map((c) => c.kind), ['HIGH_QUERY_VOLUME', 'RECURRING_SLOWNESS']);
  assert.deepEqual(suggestion.actions.map((a) => a.kind), ['INVESTIGATE_QUERIES']);
  assert.equal(suggestion.needs_human, false);
  const verdict = validateSuggestion(suggestion, ev);
  assert.equal(verdict.status, STATUS.TRUSTED, JSON.stringify(verdict.findings));
});

test('baseline says so when the data explains nothing, and asks for a person', async () => {
  const quiet = pack({ O1: { query_count_last_30d: 100, concurrent_user_peak: 5 }, O2: { avg_load_time_sec: 5 }, O3: { avg_load_time_sec: 5 }, O4: { avg_load_time_sec: 5 }, O5: { avg_load_time_sec: 5 } });
  const { suggestion } = await baselineTriager.triage(quiet);
  assert.deepEqual(suggestion.causes, []);
  assert.equal(suggestion.needs_human, true);
  const verdict = validateSuggestion(suggestion, quiet);
  assert.equal(verdict.status, STATUS.NEEDS_REVIEW);
  assert.deepEqual(verdict.findings.map((f) => f.code).sort(), ['HUMAN_REQUESTED', 'LOW_CONFIDENCE']);
});

test('baseline recommends the refresh schedule for repeated failures and an owner for an ownership gap', async () => {
  const failing = pack({ A: { alert_type: 'REFRESH_FAILURE', value: 'FAILED', threshold: undefined }, O1: { last_refresh_status: 'FAILED' }, O2: { last_refresh_status: 'TIMED_OUT' }, R: { owner_on_record_at_alert: false } });
  delete failing.items.A.fields.threshold;
  const { suggestion } = await baselineTriager.triage(failing);
  const kinds = suggestion.causes.map((c) => c.kind);
  assert.ok(kinds.includes('REPEATED_FAILURES') && kinds.includes('OWNERSHIP_GAP'));
  assert.ok(suggestion.actions.map((a) => a.kind).includes('CHECK_REFRESH_SCHEDULE'));
  assert.ok(suggestion.actions.map((a) => a.kind).includes('ASSIGN_OWNER'));
  assert.equal(validateSuggestion(suggestion, failing).status, STATUS.TRUSTED);
});

test('on every real, explainable alert the baseline is never rejected, and the counts match the independent Python check', async () => {
  const engine = createAlertEngine();
  const alerts = [];
  for (const o of store.observations()) alerts.push(...engine.process(o));
  const explainable = alerts.filter((a) => a.lifecycle !== 'RESOLVED');
  assert.equal(explainable.length, 838);

  const status = {}, causes = {};
  for (const a of explainable) {
    const ev = buildEvidence({ alert: a, store });
    const { suggestion } = await baselineTriager.triage(ev);
    const v = validateSuggestion(suggestion, ev);
    status[v.status] = (status[v.status] ?? 0) + 1;
    for (const c of suggestion.causes) causes[c.kind] = (causes[c.kind] ?? 0) + 1;
  }
  assert.deepEqual(status, { TRUSTED: 721, NEEDS_REVIEW: 117 });
  assert.deepEqual(causes, { HIGH_CONCURRENCY: 203, HIGH_QUERY_VOLUME: 210, OWNERSHIP_GAP: 107, RECURRING_SLOWNESS: 567, REPEATED_FAILURES: 62 });
});
