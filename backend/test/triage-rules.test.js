// Boundaries of the data rules: the exact values where "supported" flips to "not supported".

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CAUSE_RULES, failureRun, slowCount } from '../src/triage/rules.js';
import { pack } from './helpers/triage-fixtures.js';

const verdict = (kind, ev) => CAUSE_RULES[kind].verdict(ev);
const readings = (specs) => {
  // Replace O1..O5 with the given readings, newest first: { load, status, queries, users }
  const o = {};
  specs.forEach((r, i) => {
    o[`O${i + 1}`] = { reading: `X:${i}`, last_refresh_status: r.status ?? 'SUCCESS', avg_load_time_sec: r.load ?? 5, query_count_last_30d: r.queries ?? 100, concurrent_user_peak: r.users ?? 10, monthly_active_views: 1 };
  });
  for (let i = specs.length + 1; i <= 5; i++) o[`O${i}`] = null; // the fixture's own extra readings must not leak into the case
  return pack(o);
};

test('query volume and concurrency: exactly at the fleet quarter counts (>=), one below does not', () => {
  assert.equal(verdict('HIGH_QUERY_VOLUME', readings([{ queries: 18898 }])), true);
  assert.equal(verdict('HIGH_QUERY_VOLUME', readings([{ queries: 18897 }])), false);
  assert.equal(verdict('HIGH_CONCURRENCY', readings([{ users: 112 }])), true);
  assert.equal(verdict('HIGH_CONCURRENCY', readings([{ users: 111 }])), false);
});

test('recurring slowness: 3 of the latest 5 is enough, 2 is not, and exactly the limit is not slow', () => {
  const slow = { load: 20 }, fine = { load: 5 };
  assert.equal(verdict('RECURRING_SLOWNESS', readings([slow, slow, slow, fine, fine])), true);
  assert.equal(verdict('RECURRING_SLOWNESS', readings([slow, slow, fine, fine, fine])), false);
  assert.equal(verdict('RECURRING_SLOWNESS', readings([{ load: 15 }, { load: 15 }, { load: 15 }, { load: 15 }, { load: 15 }])), false); // 15.0 is not over 15
  assert.equal(verdict('RECURRING_SLOWNESS', readings([{ load: 15.1 }, { load: 15.1 }, { load: 15.1 }])), true); // fewer than 5 readings still counts
  assert.deepEqual(slowCount(readings([slow, slow, fine])), { slow: 2, of: 3, limit: 15 });
});

test('recurring slowness looks only at the latest 5 readings', () => {
  const ev = pack({ O6: { reading: 'X:6', last_refresh_status: 'SUCCESS', avg_load_time_sec: 50, query_count_last_30d: 1, concurrent_user_peak: 1, monthly_active_views: 1 } });
  const base = readings([{ load: 20 }, { load: 20 }, { load: 5 }, { load: 5 }, { load: 5 }]);
  base.items.O6 = ev.items.O6;
  assert.equal(verdict('RECURRING_SLOWNESS', base), false); // the slow sixth reading is outside the window
});

test('repeated failures: two in a row, FAILED or TIMED_OUT, UNKNOWN skipped, a success breaks the run', () => {
  assert.equal(verdict('REPEATED_FAILURES', readings([{ status: 'FAILED' }, { status: 'TIMED_OUT' }, { status: 'SUCCESS' }])), true);
  assert.equal(verdict('REPEATED_FAILURES', readings([{ status: 'FAILED' }, { status: 'SUCCESS' }, { status: 'FAILED' }])), false);
  assert.equal(verdict('REPEATED_FAILURES', readings([{ status: 'FAILED' }])), false);
  assert.equal(verdict('REPEATED_FAILURES', readings([{ status: 'FAILED' }, { status: 'UNKNOWN' }, { status: 'FAILED' }])), true); // unknown is skipped
  assert.equal(failureRun(readings([{ status: 'UNKNOWN' }, { status: 'FAILED' }, { status: 'FAILED' }, { status: 'FAILED' }, { status: 'SUCCESS' }])), 3);
  assert.equal(verdict('REPEATED_FAILURES', readings([{ status: 'SUCCESS' }, { status: 'FAILED' }, { status: 'FAILED' }])), false); // newest reading succeeded
});

test('ownership gap follows the owner on record at the time of the alert', () => {
  assert.equal(verdict('OWNERSHIP_GAP', pack({ R: { owner_on_record_at_alert: false } })), true);
  assert.equal(verdict('OWNERSHIP_GAP', pack({ R: { owner_on_record_at_alert: true } })), false);
  assert.equal(verdict('OWNERSHIP_GAP', pack({ R: { owner_on_record_at_alert: 'no' } })), null); // not a boolean: cannot decide
});

test('missing evidence gives "cannot decide", never a guess; OTHER can never be decided', () => {
  const noFleet = pack({ F: null });
  for (const kind of ['HIGH_QUERY_VOLUME', 'HIGH_CONCURRENCY', 'RECURRING_SLOWNESS']) assert.equal(verdict(kind, noFleet), null, kind);
  assert.equal(verdict('REPEATED_FAILURES', pack({ O1: null })), null);
  assert.equal(verdict('OTHER', pack()), null);
});
