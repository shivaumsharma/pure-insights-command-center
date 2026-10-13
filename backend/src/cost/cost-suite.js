// Runs the Phase 2 cost SQL suite (sql/10-14) against a warehouse and returns every result set.
//
//   npm run cost:build   ->  data/processed/cost_*.csv and a short summary on stdout

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv } from '../pipeline/csv.js';
import { DEFAULT_OUT } from '../pipeline/pipeline.js';
import { createWarehouseFromProcessed } from '../warehouse/local-warehouse.js';

export function runCostSuite(warehouse) {
  warehouse.runSqlFile('10_credit_attribution.sql');
  return {
    unitCost: warehouse.query('11_unit_cost.sql'),
    checks: warehouse.query('12_reconciliation_checks.sql'),
    variance: warehouse.query('13_report_variance.sql'),
    awsMismatch: warehouse.query('14_views_vs_aws_cost.sql'),
  };
}

const OUTPUTS = {
  unitCost: 'cost_per_report.csv',
  checks: 'cost_reconciliation_checks.csv',
  variance: 'cost_report_variance.csv',
  awsMismatch: 'cost_aws_mismatch.csv',
};

export function writeCostOutputs(results, outDir = DEFAULT_OUT) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [key, file] of Object.entries(OUTPUTS)) {
    const rows = results[key];
    const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
    fs.writeFileSync(path.join(outDir, file), columns.length > 0 ? toCsv(columns, rows) : '');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const wh = createWarehouseFromProcessed();
  const results = runCostSuite(wh);
  writeCostOutputs(results);

  console.log('reconciliation checks:');
  for (const c of results.checks) {
    console.log(`  ${c.check_id} ${c.status.padEnd(4)} expected ${c.expected_value} actual ${c.actual_value}  - ${c.description}`);
  }
  const inTol = results.variance.filter((v) => v.status === 'WITHIN_TOLERANCE').length;
  console.log(`reports within tolerance: ${inTol} of ${results.variance.length}`);
  console.log(`AWS mismatch flags: ${results.awsMismatch.length}`);
  wh.close();
}
