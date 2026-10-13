// A first run on a real Snowflake account found that dividing exact decimals keeps too few decimal places there (check R1 failed in 52 of 80
// warehouse-hours; the local SQLite engine uses floating point and never showed it). The scripts now divide in DOUBLE. These tests keep it that way.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const sql = (name) => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../sql', name), 'utf8')
  .split('\n').filter((line) => !line.trim().startsWith('--')).join('\n'); // code only, not comments

test('the workload share is divided in DOUBLE, not as exact decimals', () => {
  const code = sql('10_credit_attribution.sql');
  assert.match(code, /CAST\(s\.elapsed_ms AS DOUBLE\)\s*\/\s*s\.window_elapsed_ms/);
  assert.doesNotMatch(code, /\*\s*1\.0\s*\//, 'a "* 1.0 /" division is exact-decimal on Snowflake and loses precision');
});

test('the fleet hosting cost per view is divided in DOUBLE too', () => {
  const code = sql('14_views_vs_aws_cost.sql');
  assert.match(code, /CAST\(SUM\(aws_hosting_cost_usd\) AS DOUBLE\)\s*\/\s*SUM\(monthly_active_views\)/);
  assert.doesNotMatch(code, /\*\s*1\.0\s*\/\s*SUM/);
});
