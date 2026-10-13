import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAlertEngine } from '../src/alerts/engine.js';
import { latencySeverity } from '../src/alerts/rules.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';

const EPOCH = Date.UTC(2026, 8, 1);
const at = (hours) => new Date(EPOCH + hours * 3_600_000).toISOString();
const ev = (report, hours, load, status = 'SUCCESS') => ({
  observation_id: `${report}@${hours}`, report_id: report, report_name: `name ${report}`,
  observed_at: at(hours), avg_load_time_sec: load, last_refresh_status: status,
});
const lifecycles = (alerts) => alerts.map((a) => `${a.alert_type}:${a.lifecycle}${a.severity ? `:${a.severity}` : ''}`);

test('latency tiers: the threshold itself is not an alert, tier edges fall on the documented side', () => {
  const cases = [[15, null], [15.1, 'low'], [25, 'low'], [25.1, 'medium'], [35, 'medium'], [35.1, 'high'], [54.9, 'high'], [55, 'critical']];
  for (const [sec, expected] of cases) assert.equal(latencySeverity(sec), expected, `${sec}s`);
});

test('first breach TRIGGERS; repeats inside the cooldown are held back and counted; the cooldown boundary REPEATS', () => {
  const e = createAlertEngine(); // 6 h cooldown
  assert.deepEqual(lifecycles(e.process(ev('A', 0, 20))), ['LATENCY:TRIGGERED:low']);
  for (const h of [1, 2, 3, 4, 5]) assert.deepEqual(e.process(ev('A', h, 20)), [], `hour ${h}`);
  const again = e.process(ev('A', 6, 20));
  assert.deepEqual(lifecycles(again), ['LATENCY:REPEATED:low']);
  assert.equal(again[0].suppressed_since_last, 5);
  assert.deepEqual(e.process(ev('A', 7, 20)), []); // the counter and the clock were reset
});

test('a worse reading ESCALATES at once, ignoring the cooldown; getting better is silent', () => {
  const e = createAlertEngine();
  e.process(ev('A', 0, 20)); // low
  assert.deepEqual(lifecycles(e.process(ev('A', 1, 40))), ['LATENCY:ESCALATED:high']);
  assert.deepEqual(e.process(ev('A', 2, 30)), []); // better than last told: nothing to say
  assert.deepEqual(e.process(ev('A', 3, 36)), []); // back up, but not worse than "high" already announced
  assert.deepEqual(lifecycles(e.process(ev('A', 4, 55))), ['LATENCY:ESCALATED:critical']);
});

test('RESOLVED needs two consecutive clear readings; a breach in between resets the count', () => {
  const e = createAlertEngine();
  e.process(ev('A', 0, 20));
  assert.deepEqual(e.process(ev('A', 1, 5)), []); // one clear reading: not yet
  assert.deepEqual(e.process(ev('A', 2, 20)), []); // flaps back: still the same open alert, no new TRIGGERED
  assert.deepEqual(e.process(ev('A', 3, 5)), []);
  const done = e.process(ev('A', 4, 5));
  assert.deepEqual(lifecycles(done), ['LATENCY:RESOLVED:low']);
  assert.equal(done[0].active_for_ms, 4 * 3_600_000); // opened at hour 0, resolved at hour 4
  assert.deepEqual(e.process(ev('A', 5, 5)), []); // resolved only once
  assert.deepEqual(lifecycles(e.process(ev('A', 6, 20))), ['LATENCY:TRIGGERED:low']); // a fresh incident
});

test('refresh failures: FAILED is high, TIMED_OUT counts too, three in a row is critical, two successes resolve', () => {
  const e = createAlertEngine();
  assert.deepEqual(lifecycles(e.process(ev('A', 0, 5, 'FAILED'))), ['REFRESH_FAILURE:TRIGGERED:high']);
  assert.deepEqual(e.process(ev('A', 1, 5, 'TIMED_OUT')), []); // second, same severity, inside cooldown
  const third = e.process(ev('A', 2, 5, 'FAILED'));
  assert.deepEqual(lifecycles(third), ['REFRESH_FAILURE:ESCALATED:critical']);
  assert.equal(third[0].consecutive_failures, 3);
  assert.deepEqual(e.process(ev('A', 3, 5, 'SUCCESS')), []);
  assert.deepEqual(lifecycles(e.process(ev('A', 4, 5, 'SUCCESS'))), ['REFRESH_FAILURE:RESOLVED:critical']);
});

test('UNKNOWN status neither raises, resolves, nor breaks a failure streak', () => {
  const e = createAlertEngine();
  assert.deepEqual(e.process(ev('A', 0, 5, 'UNKNOWN')), []);
  e.process(ev('A', 1, 5, 'FAILED'));
  e.process(ev('A', 2, 5, 'UNKNOWN'));
  e.process(ev('A', 3, 5, 'UNKNOWN'));
  e.process(ev('A', 4, 5, 'UNKNOWN'));
  assert.equal(e.active().length, 1); // three UNKNOWNs did not resolve it
  assert.deepEqual(e.process(ev('A', 5, 5, 'FAILED')), []); // streak is 2, still "high"
  assert.deepEqual(lifecycles(e.process(ev('A', 6, 5, 'FAILED'))), ['REFRESH_FAILURE:ESCALATED:critical']); // streak 3
});

test('reports and alert types are independent of each other', () => {
  const e = createAlertEngine();
  assert.deepEqual(lifecycles(e.process(ev('A', 0, 20))), ['LATENCY:TRIGGERED:low']);
  assert.deepEqual(lifecycles(e.process(ev('B', 0, 20))), ['LATENCY:TRIGGERED:low']); // B is not silenced by A
  const both = e.process(ev('A', 1, 45, 'FAILED')); // slow AND failed on the same reading
  assert.deepEqual(lifecycles(both).sort(), ['LATENCY:ESCALATED:high', 'REFRESH_FAILURE:TRIGGERED:high']);
  assert.equal(e.active().length, 3);
});

test('alert content: message, value, threshold and report details', () => {
  const [a] = createAlertEngine().process(ev('RPT_9', 0, 31.5));
  assert.equal(a.report_id, 'RPT_9');
  assert.equal(a.value, 31.5);
  assert.equal(a.threshold, 15);
  assert.equal(a.message, 'RPT_9 (name RPT_9) load time 31.5 s is over 15 s (medium)');
  assert.equal(a.observation_id, 'RPT_9@0');
});

test('every breaching reading is either announced or counted as held back (no silent loss), on a seeded random stream', () => {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const e = createAlertEngine({ cooldownMs: 2 * 3_600_000, clearAfter: 2 });
  for (let h = 0; h < 400; h++) {
    for (const r of ['A', 'B', 'C']) {
      const status = rnd() < 0.3 ? 'FAILED' : rnd() < 0.1 ? 'UNKNOWN' : 'SUCCESS';
      e.process(ev(r, h, rnd() * 55, status));
    }
  }
  const s = e.stats();
  for (const type of ['LATENCY', 'REFRESH_FAILURE']) {
    assert.ok(s.breaches[type] > 100);
  }
  const announced = s.emitted.TRIGGERED + s.emitted.ESCALATED + s.emitted.REPEATED;
  assert.equal(announced + s.suppressed.LATENCY + s.suppressed.REFRESH_FAILURE, s.breaches.LATENCY + s.breaches.REFRESH_FAILURE);
});

test('real data matches an independent Python implementation of the same rules', () => {
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-eng-')) });
  const e = createAlertEngine();
  const byType = {};
  for (const obs of store.observations()) {
    for (const a of e.process(obs)) byType[`${a.alert_type}/${a.lifecycle}`] = (byType[`${a.alert_type}/${a.lifecycle}`] ?? 0) + 1;
  }
  const s = e.stats();
  assert.equal(s.observations, 1976);
  assert.deepEqual(s.breaches, { LATENCY: 1470, REFRESH_FAILURE: 556 });
  assert.deepEqual(s.emitted, { TRIGGERED: 486, ESCALATED: 203, REPEATED: 149, RESOLVED: 343 });
  assert.deepEqual(s.suppressed, { LATENCY: 968, REFRESH_FAILURE: 220 });
  assert.deepEqual(byType, {
    'LATENCY/TRIGGERED': 189, 'LATENCY/ESCALATED': 175, 'LATENCY/REPEATED': 138, 'LATENCY/RESOLVED': 95,
    'REFRESH_FAILURE/TRIGGERED': 297, 'REFRESH_FAILURE/ESCALATED': 28, 'REFRESH_FAILURE/REPEATED': 11, 'REFRESH_FAILURE/RESOLVED': 248,
  });
  const open = e.active();
  assert.equal(open.length, 143);
  const bySev = {};
  for (const a of open) bySev[a.severity] = (bySev[a.severity] ?? 0) + 1;
  assert.deepEqual(bySev, { high: 115, medium: 12, low: 7, critical: 9 });
  // 838 of the 2,026 breaching readings needed human attention (41%); the rest were held back or are state changes.
  assert.equal(s.emitted.TRIGGERED + s.emitted.ESCALATED + s.emitted.REPEATED, 838);
});
