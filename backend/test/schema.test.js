// sql/00_schema.sql (what Snowflake would run) must agree with the code that loads the local warehouse
// and with the CSV files the pipeline writes. A mismatch would make COPY INTO fail or load the wrong column.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseCsv } from '../src/pipeline/csv.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { DEFAULT_PARAMS, TABLES } from '../src/warehouse/local-warehouse.js';

const ddl = fs.readFileSync(path.resolve(import.meta.dirname, '../../sql/00_schema.sql'), 'utf8');

function ddlColumns(schema, table) {
  const m = ddl.match(new RegExp(`CREATE OR REPLACE TABLE PURE_INSIGHTS\\.${schema}\\.${table} \\(([\\s\\S]*?)\\n\\);`, 'i'));
  assert.ok(m, `no DDL for ${schema}.${table}`);
  return m[1].split('\n').map((l) => l.match(/^\s{2}([a-z][a-z_0-9]*)\s+[A-Z]/)).filter(Boolean).map((x) => x[1]);
}

const CSV_FOR = {
  'core.observations_clean': 'observations_clean.csv',
  'core.quarantine_ledger': 'quarantine_ledger.csv',
  'core.reports': 'reports.csv',
  'sim_account_usage.query_history': 'sim_query_history.csv',
  'sim_account_usage.warehouse_metering_history': 'sim_warehouse_metering_history.csv',
};

for (const [qualified, columns] of Object.entries(TABLES)) {
  const [schema, table] = qualified.split('.');
  test(`${qualified}: DDL columns match the loader${CSV_FOR[qualified] ? ' and the CSV header' : ''}`, () => {
    assert.deepEqual(ddlColumns(schema, table), columns);
    if (CSV_FOR[qualified]) {
      const { header } = parseCsv(fs.readFileSync(path.join(DEFAULT_OUT, CSV_FOR[qualified]), 'utf8'));
      assert.deepEqual(header, columns);
    }
  });
}

test('cost parameter defaults in the DDL match the local warehouse defaults', () => {
  const m = ddl.match(/INSERT INTO PURE_INSIGHTS\.CORE\.COST_PARAMS VALUES \(([^)]*)\)/);
  assert.ok(m, 'no COST_PARAMS insert');
  assert.deepEqual(m[1].split(',').map(Number), [DEFAULT_PARAMS.credit_price_usd, DEFAULT_PARAMS.variance_tolerance_pct, DEFAULT_PARAMS.aws_mismatch_ratio]);
});
