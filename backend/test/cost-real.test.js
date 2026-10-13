// The cost suite on the real data. Expected figures come from an independent Python re-implementation
// (plain csv module, no shared code with the SQL), not from the SQL's own output.

import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { runCostSuite } from '../src/cost/cost-suite.js';
import { createWarehouseFromProcessed } from '../src/warehouse/local-warehouse.js';

const wh = createWarehouseFromProcessed();
const results = runCostSuite(wh);
after(() => wh.close());
const check = (id) => results.checks.find((c) => c.check_id === id);

test('structural checks R1-R6 all pass on the real data', () => {
  for (const id of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6']) assert.equal(check(id).status, 'PASS', `${id}: ${check(id).description}`);
});

test('R7 is INFO (circular by construction) and R8 FAILS for 64 reports, as designed', () => {
  assert.equal(check('R7').status, 'INFO');
  assert.ok(Math.abs(check('R7').actual_value - 1206352.48) < 0.01);
  assert.equal(check('R8').status, 'FAIL');
  assert.equal(check('R8').actual_value, 64);
  assert.equal(results.variance.filter((v) => v.status === 'WITHIN_TOLERANCE').length, 36);
  assert.equal(results.variance.length, 100);
});

test('unit cost: 100 reports, most expensive first, matching the independent figures', () => {
  assert.equal(results.unitCost.length, 100);
  const [first, second, third] = results.unitCost;
  assert.deepEqual([first.report_id, first.total_cost_usd], ['RPT_299', 71948.79]);
  assert.deepEqual([second.report_id, second.total_cost_usd], ['RPT_260', 59056.55]);
  assert.deepEqual([third.report_id, third.total_cost_usd], ['RPT_254', 57642.2]);
  assert.equal(first.cost_per_view_usd, 4.7232);
  assert.ok(results.unitCost.every((r) => r.cost_per_view_usd !== null && r.cost_per_view_usd > 0));
});

test('idle spend (zero-view observations) matches, within per-report cent rounding', () => {
  const idle = results.unitCost.reduce((s, r) => s + r.idle_cost_usd, 0);
  assert.ok(Math.abs(idle - 8826.58) < 0.05, `idle ${idle}`);
  assert.equal(results.unitCost.reduce((s, r) => s + r.zero_view_observations, 0), 4);
});

test('credit price placeholder flows through: total cost = attributed credits x price + AWS', () => {
  for (const r of results.unitCost.slice(0, 10)) {
    assert.ok(Math.abs(r.total_cost_usd - (r.attributed_credits * 3 + r.aws_cost_usd)) < 0.05, r.report_id);
  }
});

test('orphaned spend can be read straight off the unit-cost result', () => {
  assert.equal(results.unitCost.filter((r) => r.is_orphaned === 1).length, 13);
});

test('AWS mismatch: 625 flagged observations in the independent split', () => {
  const by = {};
  for (const r of results.awsMismatch) by[r.mismatch_type] = (by[r.mismatch_type] ?? 0) + 1;
  assert.deepEqual(by, { COST_HIGH_FOR_USAGE: 322, COST_LOW_FOR_USAGE: 299, ZERO_VIEWS_WITH_COST: 4 });
  assert.equal(results.awsMismatch.length, 625);
});
