// Integration test on the real CSV. The expected numbers were computed with a separate Python script
// (csv module, no shared code with the pipeline), not copied from the pipeline's own output.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { runPipeline } from '../src/pipeline/pipeline.js';
import { warehouseFor } from '../src/pipeline/simulate.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-pipeline-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const result = runPipeline({ outDir: path.join(tmp, 'a') });
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

test('real CSV: row counts and the single quarantine reason', () => {
  assert.equal(result.dq.rows.in, 2000);
  assert.equal(result.clean.length, 1976);
  assert.equal(result.quarantine.length, 24);
  assert.deepEqual(result.dq.quarantine_by_reason, { NEGATIVE_CREDITS: 24 });
  assert.equal(result.dq.rows.conserved, true);
  assert.ok(result.clean.every((o) => o.snowflake_credits_consumed >= 0));
});

test('real CSV: flags match the independent count', () => {
  const f = result.dq.flags_on_clean_rows;
  assert.equal(f.orphan_observations, 242);
  assert.equal(f.orphan_missing, 125);
  assert.equal(f.orphan_sentinel, 117);
  assert.equal(f.status_unknown, 98);
  assert.equal(f.zero_views, 4);
  assert.equal(f.concurrency_exceeds_views, 91);
  assert.equal(result.dq.latency.breaches, 1470);
  assert.equal(result.dq.latency.at_ceiling, 6);
  assert.equal(result.dq.latency.max_sec, 55);
});

test('real CSV: report roll-up', () => {
  assert.equal(result.reports.length, 100);
  assert.equal(result.dq.reports.currently_orphaned, 13);
  assert.ok(result.reports.every((r) => r.observation_count <= 20));
});

test('credits: clean total matches the independent total', () => {
  assert.ok(Math.abs(sum(result.clean, (o) => o.snowflake_credits_consumed) - 1206352.48) < 0.01);
});

test('simulated metering totals equal the clean credits (true by construction)', () => {
  const cleanTotal = sum(result.clean, (o) => o.snowflake_credits_consumed);
  assert.ok(Math.abs(sum(result.metering, (m) => m.credits_used) - cleanTotal) < 1e-3);
  assert.ok(result.metering.every((m) => m.credits_used >= 0 && m.credits_used === m.credits_used_compute));
});

test('simulated query history: one row per clean observation, valid warehouse, linked by query tag', () => {
  assert.equal(result.queryHistory.length, result.clean.length);
  const warehouses = new Set(result.metering.map((m) => m.warehouse_name));
  for (const q of result.queryHistory) {
    assert.ok(warehouses.has(q.warehouse_name));
    assert.match(q.query_tag, /^report:RPT_\d+$/);
    assert.equal(q.warehouse_name, warehouseFor(q.query_tag.replace('report:', '')));
  }
  assert.equal(new Set(result.queryHistory.map((q) => q.query_id)).size, result.queryHistory.length);
});

test('output is deterministic: a second run writes byte-identical files', () => {
  runPipeline({ outDir: path.join(tmp, 'b') });
  for (const name of fs.readdirSync(path.join(tmp, 'a'))) {
    assert.equal(
      fs.readFileSync(path.join(tmp, 'a', name), 'utf8'),
      fs.readFileSync(path.join(tmp, 'b', name), 'utf8'),
      name,
    );
  }
});

test('every quarantined row is reproducible from the ledger', () => {
  const ledger = fs.readFileSync(path.join(tmp, 'a', 'quarantine_ledger.csv'), 'utf8').trim().split('\n');
  assert.equal(ledger.length - 1, 24);
  assert.ok(ledger.slice(1).every((l) => l.includes('NEGATIVE_CREDITS')));
});
