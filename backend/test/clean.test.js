import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanObservations, normalizeOwner, normalizeStatus, parseNumber } from '../src/pipeline/clean.js';
import { parseCsv, toCsv } from '../src/pipeline/csv.js';
import { buildReports } from '../src/pipeline/reports.js';

const HEADER =
  'report_id,report_name,owner_email,last_refresh_status,monthly_active_views,snowflake_credits_consumed,avg_load_time_sec,aws_hosting_cost_usd,query_count_last_30d,concurrent_user_peak';

// Builds a one-off CSV from partial row overrides; defaults are a perfectly valid row.
function run(...overrides) {
  const base = {
    report_id: 'RPT_1', report_name: 'R', owner_email: 'user_1@company.com', last_refresh_status: 'SUCCESS',
    monthly_active_views: '100', snowflake_credits_consumed: '10', avg_load_time_sec: '5',
    aws_hosting_cost_usd: '20', query_count_last_30d: '50', concurrent_user_peak: '10',
  };
  const lines = overrides.map((o) => Object.values({ ...base, ...o }).join(','));
  return cleanObservations(parseCsv([HEADER, ...lines].join('\n')));
}

test('csv: quoted commas, escaped quotes, CRLF and BOM', () => {
  const { header, rows } = parseCsv('﻿a,b\r\n"x,1","he said ""hi"""\r\n');
  assert.deepEqual(header, ['a', 'b']);
  assert.deepEqual(rows[0].fields, ['x,1', 'he said "hi"']);
  assert.equal(toCsv(['a', 'b'], [{ a: 'x,1', b: null }]), 'a,b\n"x,1",\n');
});

test('owner: nan / empty / sentinel / invalid are orphans, valid email is normalised', () => {
  assert.deepEqual(normalizeOwner('nan'), { email: null, orphanKind: 'MISSING' });
  assert.deepEqual(normalizeOwner('  '), { email: null, orphanKind: 'MISSING' });
  assert.deepEqual(normalizeOwner('ORPHANED_REPORT'), { email: null, orphanKind: 'SENTINEL' });
  assert.deepEqual(normalizeOwner('not-an-email'), { email: null, orphanKind: 'INVALID' });
  assert.deepEqual(normalizeOwner(' User_7@Company.COM '), { email: 'user_7@company.com', orphanKind: null });
});

test('status: normalises case and separators, maps junk to UNKNOWN and says so', () => {
  assert.deepEqual(normalizeStatus(' timed out '), { status: 'TIMED_OUT', recognised: true });
  assert.deepEqual(normalizeStatus('success'), { status: 'SUCCESS', recognised: true });
  assert.deepEqual(normalizeStatus('???'), { status: 'UNKNOWN', recognised: false });
});

test('parseNumber is strict', () => {
  assert.equal(parseNumber('12.5'), 12.5);
  assert.equal(parseNumber('-3'), -3);
  for (const bad of ['', ' ', 'abc', '1,000', '12abc', 'NaN', 'Infinity']) assert.ok(Number.isNaN(parseNumber(bad)), bad);
});

test('negative credits are quarantined, with the reason code', () => {
  const { clean, quarantine } = run({}, { snowflake_credits_consumed: '-13.6' });
  assert.equal(clean.length, 1);
  assert.equal(quarantine.length, 1);
  assert.equal(quarantine[0].reason_codes, 'NEGATIVE_CREDITS');
  assert.match(quarantine[0].reason_detail, /-13\.6/);
});

test('other negatives, non-numeric and non-integer counts are quarantined with distinct codes', () => {
  const { clean, quarantine } = run(
    { aws_hosting_cost_usd: '-1' },
    { avg_load_time_sec: 'fast' },
    { monthly_active_views: '10.5' },
  );
  assert.equal(clean.length, 0);
  assert.deepEqual(quarantine.map((q) => q.reason_codes), ['NEGATIVE_VALUE', 'NON_NUMERIC', 'NON_INTEGER']);
});

test('orphans, UNKNOWN status and zero views are flagged but NOT quarantined', () => {
  const { clean, quarantine } = run({ owner_email: 'ORPHANED_REPORT', last_refresh_status: 'UNKNOWN', monthly_active_views: '0' });
  assert.equal(quarantine.length, 0);
  const [o] = clean;
  assert.equal(o.owner_email, null);
  assert.equal(o.is_orphan, true);
  assert.equal(o.orphan_kind, 'SENTINEL');
  assert.equal(o.status_unknown, true);
  assert.equal(o.zero_views, true);
});

test('latency flag is strictly greater than 15 s; ceiling flag is at 55 s', () => {
  const { clean } = run({ avg_load_time_sec: '15' }, { avg_load_time_sec: '15.1' }, { avg_load_time_sec: '55' });
  assert.deepEqual(clean.map((o) => o.latency_breach), [false, true, true]);
  assert.deepEqual(clean.map((o) => o.latency_at_ceiling), [false, false, true]);
});

test('exact duplicate rows and malformed rows are quarantined', () => {
  const dup = run({}, {});
  assert.equal(dup.clean.length, 1);
  assert.equal(dup.quarantine[0].reason_codes, 'DUPLICATE_ROW');
  const bad = cleanObservations(parseCsv(`${HEADER}\nRPT_1,only,three`));
  assert.equal(bad.quarantine[0].reason_codes, 'MALFORMED_ROW');
});

test('missing required column fails loudly instead of cleaning wrongly', () => {
  assert.throws(() => cleanObservations(parseCsv('report_id,report_name\nRPT_1,x')), /missing required columns/);
});

test('no rows are lost: clean + quarantine always equals input', () => {
  const out = run({}, { snowflake_credits_consumed: '-1' }, { avg_load_time_sec: 'x' }, {}, { owner_email: 'nan' });
  assert.equal(out.clean.length + out.quarantine.length, 5);
  assert.equal(out.quarantine.length, 3); // negative, non-numeric, and the exact duplicate of row 1
});

test('timeline: k-th row of a report is its k-th hour; a quarantined row keeps its slot', () => {
  const { clean } = run({}, { snowflake_credits_consumed: '-1' }, { monthly_active_views: '101' });
  assert.equal(clean[0].observed_at, '2026-09-01T00:00:00.000Z');
  assert.equal(clean[1].observed_at, '2026-09-01T02:00:00.000Z');
  assert.equal(clean[1].observation_id, 'RPT_1:003');
});

test('report roll-up: orphaned means the LATEST observation has no owner; last known owner is kept', () => {
  const { clean } = run({ owner_email: 'user_1@company.com' }, { owner_email: 'user_2@company.com' }, { owner_email: 'nan' });
  const [r] = buildReports(clean);
  assert.equal(r.is_orphaned, true);
  assert.equal(r.current_owner_email, null);
  assert.equal(r.last_known_owner_email, 'user_2@company.com');
  assert.equal(r.distinct_owner_count, 2);
  assert.equal(r.orphan_observation_count, 1);

  const { clean: recovered } = run({ owner_email: 'nan' }, { owner_email: 'user_3@company.com' });
  assert.equal(buildReports(recovered)[0].is_orphaned, false);
});
