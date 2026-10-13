// Cost SQL tested on tiny inputs whose answers are worked out by hand in the comments.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { runCostSuite } from '../src/cost/cost-suite.js';
import { createWarehouse } from '../src/warehouse/local-warehouse.js';

const PARAMS = { credit_price_usd: 2, variance_tolerance_pct: 10, aws_mismatch_ratio: 3 };
const T0 = '2026-09-01T00:00:00.000Z'; // window 1 starts here
const T0b = '2026-09-01T00:00:30.000Z';
const T1 = '2026-09-01T01:00:00.000Z';
const T2 = '2026-09-01T02:00:00.000Z';

const obs = (id, report, at, views, reported, aws) => ({
  observation_id: id, report_id: report, report_name: `name ${report}`, owner_email: null,
  observed_at: at, monthly_active_views: views, snowflake_credits_consumed: reported, aws_hosting_cost_usd: aws,
});
const query = (id, report, at, elapsedMs) => ({
  query_id: id, query_tag: `report:${report}`, warehouse_name: 'WH_A', start_time: at,
  total_elapsed_time_ms: elapsedMs, query_count: 1, execution_status: 'SUCCESS',
});
const windowRow = (start, end, credits) => ({
  start_time: start, end_time: end, warehouse_id: 1, warehouse_name: 'WH_A',
  credits_used_compute: credits, credits_used_cloud_services: 0, credits_used: credits,
});
const check = (results, id) => results.checks.find((c) => c.check_id === id);
const near = (actual, expected, msg) => assert.ok(Math.abs(actual - expected) < 1e-9, `${msg}: ${actual} vs ${expected}`);

// Hand calculation, window 1 = 100 credits:
//   A ran 3000 ms, B ran 1000 ms  ->  A gets 3000/4000 x 100 = 75, B gets 25.
//   price 2:  A credit cost 150, + AWS 10 = 160 over 80 views = 2.00 per view.
//             B credit cost  50, + AWS  5 =  55 over  0 views = no unit cost, all 55 is idle spend.
//   CSV claims A used 70 and B used 32: A is +7.14% off (inside 10%), B is -21.88% off (outside).
function baseline(extra = {}) {
  return createWarehouse({
    observations: [obs('A:001', 'A', T0, 80, 70, 10), obs('B:001', 'B', T0b, 0, 32, 5)],
    queryHistory: [query('Q1', 'A', T0, 3000), query('Q2', 'B', T0b, 1000)],
    metering: [windowRow(T0, T1, 100)],
    reports: [{ report_id: 'A', is_orphaned: true, last_known_owner_email: 'a@x.com' }, { report_id: 'B', is_orphaned: false }],
    params: PARAMS,
    ...extra,
  });
}

test('attribution splits a warehouse-hour by elapsed-time share', () => {
  const wh = baseline();
  runCostSuite(wh);
  const rows = wh.query('SELECT report_id, workload_share, attributed_credits FROM core.cost_allocation ORDER BY report_id');
  near(rows[0].attributed_credits, 75, 'A credits');
  near(rows[1].attributed_credits, 25, 'B credits');
  near(rows[0].workload_share, 0.75, 'A share');
});

test('unit cost: credits x price + AWS, divided by views; zero views gives NULL and idle spend', () => {
  const { unitCost } = runCostSuite(baseline());
  const a = unitCost.find((r) => r.report_id === 'A');
  const b = unitCost.find((r) => r.report_id === 'B');
  assert.equal(a.total_cost_usd, 160);
  assert.equal(a.cost_per_view_usd, 2);
  assert.equal(a.credit_cost_per_view_usd, 1.875); // 150 / 80
  assert.equal(a.idle_cost_usd, 0);
  assert.equal(b.total_cost_usd, 55);
  assert.equal(b.cost_per_view_usd, null);
  assert.equal(b.idle_cost_usd, 55);
  assert.equal(b.zero_view_observations, 1);
  assert.deepEqual(unitCost.map((r) => r.report_id), ['A', 'B']); // most expensive first
});

test('unit cost carries orphan status and last known owner from core.reports', () => {
  const a = runCostSuite(baseline()).unitCost.find((r) => r.report_id === 'A');
  assert.equal(a.is_orphaned, 1);
  assert.equal(a.last_known_owner_email, 'a@x.com');
});

test('unit cost responds to the credit price parameter', () => {
  const wh = baseline({ params: { ...PARAMS, credit_price_usd: 4 } });
  const a = runCostSuite(wh).unitCost.find((r) => r.report_id === 'A');
  assert.equal(a.total_cost_usd, 310); // 75 x 4 + 10
});

test('reconciliation on a balanced warehouse: structural checks pass, per-report check catches the CSV drift', () => {
  const results = runCostSuite(baseline());
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) assert.equal(check(results, id).status, 'PASS', id);
  assert.equal(check(results, 'R7').status, 'INFO');
  near(check(results, 'R7').actual_value, 100, 'R7 attributed total');
  assert.equal(check(results, 'R8').status, 'FAIL');
  assert.equal(check(results, 'R8').actual_value, 1); // only B is outside tolerance
});

test('report variance detail: signed percentages and status', () => {
  const { variance } = runCostSuite(baseline());
  const a = variance.find((v) => v.report_id === 'A');
  const b = variance.find((v) => v.report_id === 'B');
  assert.equal(a.variance_pct, 7.14);
  assert.equal(a.status, 'WITHIN_TOLERANCE');
  assert.equal(b.variance_pct, -21.88);
  assert.equal(b.status, 'OUTSIDE_TOLERANCE');
  assert.equal(variance[0].report_id, 'B'); // worst absolute difference first
});

test('reconciliation catches each way the join can go wrong', () => {
  // Added to the baseline:
  //  - metering window 2 holds 10 credits but no queries ran               -> R2 = 10
  //  - query QX at hour 3 has no metering window                           -> R5 = 1
  //  - observation D:001 has no query row                                  -> R3 = 1
  //  - query QE is inside window 1 but belongs to no observation           -> R4 = 1
  const wh = createWarehouse({
    observations: [obs('A:001', 'A', T0, 80, 70, 10), obs('B:001', 'B', T0b, 0, 30, 5), obs('D:001', 'D', T0b, 5, 1, 1)],
    queryHistory: [
      query('Q1', 'A', T0, 3000), query('Q2', 'B', T0b, 1000), query('QE', 'E', T0b, 1000),
      query('QX', 'A', '2026-09-01T05:00:00.000Z', 500),
    ],
    metering: [windowRow(T0, T1, 100), windowRow(T1, T2, 10)],
    params: PARAMS,
  });
  const results = runCostSuite(wh);
  assert.equal(check(results, 'R2').actual_value, 10);
  assert.equal(check(results, 'R2').status, 'FAIL');
  assert.equal(check(results, 'R3').actual_value, 1);
  assert.equal(check(results, 'R4').actual_value, 1);
  assert.equal(check(results, 'R5').actual_value, 1);
  // QE still carries credits (A 3000, B 1000, E 1000 of 5000 -> A 60, B 20, E 20), so the hour still balances.
  assert.equal(check(results, 'R1').status, 'PASS');
  const e = wh.query("SELECT attributed_credits FROM core.cost_allocation WHERE report_id = 'E'");
  near(e[0].attributed_credits, 20, 'orphaned query credits');
});

test('a warehouse-hour with queries but zero elapsed time cannot be attributed, and R1 says so', () => {
  const wh = createWarehouse({
    observations: [obs('A:001', 'A', T0, 10, 50, 1)],
    queryHistory: [query('Q1', 'A', T0, 0)],
    metering: [windowRow(T0, T1, 100)],
    params: PARAMS,
  });
  const results = runCostSuite(wh);
  assert.equal(check(results, 'R1').status, 'FAIL');
  assert.equal(wh.query('SELECT attributed_credits AS c FROM core.cost_allocation')[0].c, 0);
});

test('AWS mismatch: high, low and zero-view cases are flagged, normal rows are not', () => {
  // Eight normal observations (100 views, $100), one costly ($700), one cheap ($10), two with zero views.
  // Fleet rate = (800 + 700 + 10) / 1000 views = $1.51/view, so 100 views should cost $151.
  //   costly: 700 / 151 = 4.64 (>= 3 -> high)    cheap: 10 / 151 = 0.066 (<= 1/3 -> low)
  //   normal: 100 / 151 = 0.66 (not flagged)     zero views with $50 -> flagged, zero views with $0 -> not
  const observations = [];
  for (let i = 1; i <= 8; i++) observations.push(obs(`N${i}:001`, `N${i}`, T0, 100, 0, 100));
  observations.push(obs('HI:001', 'HI', T0, 100, 0, 700), obs('LO:001', 'LO', T0, 100, 0, 10));
  observations.push(obs('Z1:001', 'Z1', T0, 0, 0, 50), obs('Z2:001', 'Z2', T0, 0, 0, 0));
  const wh = createWarehouse({ observations, params: PARAMS });
  const rows = wh.query('14_views_vs_aws_cost.sql');
  assert.deepEqual(
    rows.map((r) => [r.report_id, r.mismatch_type]).sort(),
    [['HI', 'COST_HIGH_FOR_USAGE'], ['LO', 'COST_LOW_FOR_USAGE'], ['Z1', 'ZERO_VIEWS_WITH_COST']],
  );
  const hi = rows.find((r) => r.report_id === 'HI');
  assert.equal(hi.expected_aws_usd, 151);
  assert.equal(hi.excess_aws_usd, 549);
  assert.equal(hi.cost_ratio, 4.64);
  assert.equal(rows[0].report_id, 'HI'); // largest overspend first
});

test('SQL files avoid dialect-specific constructs that would break portability', () => {
  const banned = ['QUALIFY', 'DATE_TRUNC', 'DIV0', 'IFF(', '::', 'ZEROIFNULL', 'LISTAGG', 'FLATTEN', 'DATEADD', 'DATEDIFF',
    'TO_TIMESTAMP', 'STRFTIME', 'PRINTF', 'IFNULL', 'NVL', 'CURRENT_TIMESTAMP', 'CREATE OR REPLACE'];
  for (const file of ['10_credit_attribution.sql', '11_unit_cost.sql', '12_reconciliation_checks.sql', '13_report_variance.sql', '14_views_vs_aws_cost.sql']) {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../../sql', file), 'utf8');
    const code = sql.replace(/--.*$/gm, '').toUpperCase();
    for (const word of banned) assert.ok(!code.includes(word), `${file} uses ${word}`);
  }
});
