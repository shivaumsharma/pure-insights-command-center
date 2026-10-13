import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createAlertService } from '../src/alerts/service.js';
import { createSimulator } from '../src/alerts/simulator.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';

const EPOCH = Date.UTC(2026, 8, 1);
const at = (hours) => new Date(EPOCH + hours * 3_600_000).toISOString();
const breach = (report, hours = 0, load = 20) => ({
  observation_id: `${report}@${hours}`, report_id: report, report_name: report, observed_at: at(hours),
  avg_load_time_sec: load, last_refresh_status: 'SUCCESS',
});
// A stand-in store: who owns which report.
const owners = { A: 'o1@x.com', B: 'o2@x.com', C: 'o1@x.com' };
const fakeStore = { summary: (id) => (id in owners ? { owner_email: owners[id] } : null) };
const admin = { email: 'admin@x.com', role: 'admin' };
const viewer = { email: 'v@x.com', role: 'viewer' };
const owner1 = { email: 'o1@x.com', role: 'owner' };
const owner2 = { email: 'o2@x.com', role: 'owner' };

test('event ids start at 1 and increase by one per published alert; suppressed readings get no id', () => {
  const svc = createAlertService({ store: fakeStore });
  assert.equal(svc.lastEventId(), 0);
  assert.equal(svc.oldestEventId(), null);
  svc.ingest(breach('A', 0));
  svc.ingest(breach('A', 1)); // inside the cooldown: no alert, so no id
  svc.ingest(breach('B', 1));
  assert.equal(svc.lastEventId(), 2);
  assert.deepEqual(svc.list(admin).map((a) => a.event_id), [2, 1]); // newest first
});

test('subscribers receive every published alert in order until they unsubscribe', () => {
  const svc = createAlertService({ store: fakeStore });
  const seen = [];
  const off = svc.subscribe((a) => seen.push(a.event_id));
  svc.ingest(breach('A'));
  svc.ingest(breach('B'));
  off();
  svc.ingest(breach('C'));
  assert.deepEqual(seen, [1, 2]);
});

test('role filter: admin and viewer see everything; an owner sees only reports they currently own', () => {
  const svc = createAlertService({ store: fakeStore });
  for (const r of ['A', 'B', 'C']) svc.ingest(breach(r));
  assert.equal(svc.list(admin).length, 3);
  assert.equal(svc.list(viewer).length, 3);
  assert.deepEqual(svc.list(owner1).map((a) => a.report_id).sort(), ['A', 'C']);
  assert.deepEqual(svc.list(owner2).map((a) => a.report_id), ['B']);
  assert.deepEqual(svc.active(owner2).map((a) => a.report_id), ['B']);
});

test('ownership is evaluated when asked, so reassigning a report moves its history with it', () => {
  const live = { ...owners };
  const svc = createAlertService({ store: { summary: (id) => ({ owner_email: live[id] }) } });
  svc.ingest(breach('A'));
  assert.equal(svc.list(owner1).length, 1);
  live.A = 'o2@x.com';
  assert.equal(svc.list(owner1).length, 0);
  assert.equal(svc.list(owner2).length, 1);
});

test('since(): returns only what the client missed, in order; reports a gap only when events were dropped', () => {
  const svc = createAlertService({ store: fakeStore, historyCapacity: 3 });
  for (const r of ['A', 'B', 'C', 'A2', 'B2']) { owners[r] = owners[r] ?? 'o1@x.com'; svc.ingest(breach(r)); } // ids 1..5, ring keeps 3..5
  assert.equal(svc.oldestEventId(), 3);

  const fresh = svc.since(admin, 4);
  assert.deepEqual(fresh.alerts.map((a) => a.event_id), [5]);
  assert.equal(fresh.gap, false);

  const boundary = svc.since(admin, 2); // client has 1-2, ring starts at 3: nothing lost
  assert.deepEqual(boundary.alerts.map((a) => a.event_id), [3, 4, 5]);
  assert.equal(boundary.gap, false);

  const lost = svc.since(admin, 1); // event 2 was dropped
  assert.equal(lost.gap, true);
  assert.equal(lost.oldest_event_id, 3);
  assert.deepEqual(lost.alerts.map((a) => a.event_id), [3, 4, 5]);

  assert.deepEqual(svc.since(admin, 5), { alerts: [], gap: false, ahead: false, oldest_event_id: 3 });

  // A position beyond the newest event can only come from an earlier run of the server (ids restart at 1).
  const ahead = svc.since(admin, 6);
  assert.equal(ahead.gap, true);
  assert.equal(ahead.ahead, true);
  assert.deepEqual(ahead.alerts, []);
  assert.match(svc.streamId(), /^[a-z0-9]{8}$/);
  assert.notEqual(svc.streamId(), createAlertService({ store: fakeStore }).streamId()); // a new service is a new run
});

test('list filters combine: type, severity, lifecycle, report', () => {
  const svc = createAlertService({ store: fakeStore });
  svc.ingest(breach('A', 0, 20)); // low
  svc.ingest(breach('A', 1, 40)); // escalates to high
  svc.ingest({ ...breach('B', 0, 5), last_refresh_status: 'FAILED' });
  assert.equal(svc.list(admin, { severity: 'high' }).length, 2); // A escalated + B failure
  assert.equal(svc.list(admin, { alertType: 'REFRESH_FAILURE' }).length, 1);
  assert.equal(svc.list(admin, { lifecycle: 'ESCALATED' }).length, 1);
  assert.equal(svc.list(admin, { reportId: 'A' }).length, 2);
  assert.equal(svc.list(admin, { reportId: 'A', severity: 'low' }).length, 1);
});

// ------------------------------------------------------------------ simulator

const realObservations = () => loadStore({ dataDir: DEFAULT_OUT, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-sim-')) }).observations();

test('simulator replays in time order and wraps around with shifted timestamps so event time never goes backwards', () => {
  const observations = realObservations();
  const got = [];
  const sim = createSimulator({ observations, onEvent: (e) => got.push(e) });
  for (let i = 0; i < observations.length * 2 + 5; i++) sim.step();

  const times = got.map((e) => e.observed_at);
  assert.deepEqual(times, [...times].sort()); // never decreasing, across both cycle boundaries
  assert.equal(new Set(got.map((e) => e.observation_id)).size, got.length); // ids are unique across cycles

  const n = observations.length;
  assert.equal(got[n].observation_id, `${got[0].observation_id}@c2`);
  assert.equal(Date.parse(got[n].observed_at) - Date.parse(got[0].observed_at), sim.spanMs());
  assert.equal(sim.spanMs() % 3_600_000, 0); // whole hours
  assert.deepEqual(sim.position(), { cycle: 2, index: 5, total: n });
  assert.equal(got[n].avg_load_time_sec, got[0].avg_load_time_sec); // same readings, later clock
});

test('simulator start/stop paces events on a timer and stops cleanly', async () => {
  const got = [];
  const sim = createSimulator({ observations: realObservations(), onEvent: (e) => got.push(e), eventsPerSecond: 500 });
  assert.equal(sim.isRunning(), false);
  const started = Date.now();
  sim.start();
  sim.start(); // second start is a no-op, not a second timer
  // Wait for the condition, not for a fixed time: on a busy machine a fixed 120 ms can deliver almost nothing.
  while (got.length <= 5 && Date.now() - started < 5000) await new Promise((r) => setTimeout(r, 10));
  sim.stop();
  const elapsed = Date.now() - started;
  const count = got.length;
  assert.ok(count > 5, `got ${count}`);
  // Paced, not flooding: at 500 per second a timer cannot legitimately deliver more than one event per 2 ms (plus slack for a first tick).
  assert.ok(count <= Math.ceil(elapsed / 2) + 5, `${count} events in ${elapsed} ms is faster than the configured rate`);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(got.length, count);
  assert.equal(sim.isRunning(), false);
});

test('simulator refuses an empty data set, and a failing handler does not kill the timer', async () => {
  assert.throws(() => createSimulator({ observations: [], onEvent() {} }), /at least one observation/);
  let calls = 0;
  const sim = createSimulator({
    observations: realObservations(), eventsPerSecond: 500, logger: { error() {} },
    onEvent: () => { if (++calls === 1) throw new Error('boom'); },
  });
  sim.start();
  await new Promise((r) => setTimeout(r, 80));
  sim.stop();
  assert.ok(calls > 1, 'kept running after the first handler threw');
});

test('full replay through the service reproduces the independent alert counts, with event ids matching the alerts published', () => {
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-full-')) });
  const svc = createAlertService({ store, historyCapacity: 5000 });
  const sim = createSimulator({ observations: store.observations(), onEvent: (o) => svc.ingest(o) });
  for (let i = 0; i < 1976; i++) sim.step();
  assert.equal(svc.lastEventId(), 1181);
  assert.equal(svc.list({ role: 'admin', email: 'a' }).length, 1181);
  const ownerView = svc.list({ role: 'owner', email: 'user_6@company.com' });
  assert.ok(ownerView.length > 0 && ownerView.length < 1181);
  assert.ok(ownerView.every((a) => store.summary(a.report_id).owner_email === 'user_6@company.com'));
});
