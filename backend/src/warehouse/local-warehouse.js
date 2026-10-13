// A local stand-in for Snowflake: the same schemas (core, sim_account_usage) in an in-memory SQLite database,
// running the SAME .sql files from /sql. This is what lets the cost logic be tested on known inputs and served
// by the backend without a Snowflake account.
//
// Limits to keep in mind: SQLite is not Snowflake. The sql/ scripts are deliberately limited to the portable
// subset (CTEs, window functions, range joins, COALESCE/ROUND/REPLACE), but they have never been run on real
// Snowflake in this repo. See docs/decisions.md (D9).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { CLEAN_COLUMNS, QUARANTINE_COLUMNS } from '../pipeline/clean.js';
import { parseCsv } from '../pipeline/csv.js';
import { DEFAULT_OUT } from '../pipeline/pipeline.js';
import { REPORT_COLUMNS } from '../pipeline/reports.js';
import { METERING_COLUMNS, QUERY_HISTORY_COLUMNS } from '../pipeline/simulate.js';

const SQL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../sql');

export const COST_PARAM_COLUMNS = ['credit_price_usd', 'variance_tolerance_pct', 'aws_mismatch_ratio'];
// Must stay in step with the INSERT in sql/00_schema.sql (a test checks this).
export const DEFAULT_PARAMS = { credit_price_usd: 3.0, variance_tolerance_pct: 10.0, aws_mismatch_ratio: 3.0 };

export const TABLES = {
  'core.observations_clean': CLEAN_COLUMNS,
  'core.quarantine_ledger': QUARANTINE_COLUMNS,
  'core.reports': REPORT_COLUMNS,
  'core.cost_params': COST_PARAM_COLUMNS,
  'sim_account_usage.query_history': QUERY_HISTORY_COLUMNS,
  'sim_account_usage.warehouse_metering_history': METERING_COLUMNS,
};

const BOOLEAN_COLUMNS = new Set([
  'is_orphan', 'status_unknown', 'status_unrecognised', 'zero_views', 'latency_breach',
  'latency_at_ceiling', 'concurrency_exceeds_views', 'is_orphaned',
]);
const TEXT_COLUMNS = new Set([
  'observation_id', 'report_id', 'report_name', 'owner_email', 'last_refresh_status', 'orphan_kind', 'observed_at',
  'reason_codes', 'reason_detail', 'raw_record', 'first_observed_at', 'last_observed_at', 'current_owner_email',
  'last_known_owner_email', 'query_id', 'query_tag', 'warehouse_name', 'start_time', 'end_time', 'execution_status',
]);

function coerce(column, value) {
  if (value === null || value === undefined || value === '') return null;
  if (BOOLEAN_COLUMNS.has(column)) return value === true || value === 'true' || value === 1 ? 1 : 0;
  if (TEXT_COLUMNS.has(column)) return String(value);
  return Number(value);
}

export class Warehouse {
  constructor(db) {
    this.db = db;
  }

  runSqlFile(name) {
    this.db.exec(fs.readFileSync(path.join(SQL_DIR, name), 'utf8'));
  }

  // Runs a single SELECT (inline text or a file in /sql) and returns plain row objects.
  query(sqlOrFile, ...params) {
    const sql = sqlOrFile.endsWith('.sql') ? fs.readFileSync(path.join(SQL_DIR, sqlOrFile), 'utf8') : sqlOrFile;
    return this.db.prepare(sql).all(...params).map((row) => ({ ...row }));
  }

  close() {
    this.db.close();
  }
}

export function createWarehouse({
  observations = [], quarantine = [], reports = [], queryHistory = [], metering = [], params = DEFAULT_PARAMS,
}) {
  const db = new DatabaseSync(':memory:');
  db.exec("ATTACH DATABASE ':memory:' AS core; ATTACH DATABASE ':memory:' AS sim_account_usage;");

  const data = {
    'core.observations_clean': observations,
    'core.quarantine_ledger': quarantine,
    'core.reports': reports,
    'core.cost_params': [params],
    'sim_account_usage.query_history': queryHistory,
    'sim_account_usage.warehouse_metering_history': metering,
  };

  db.exec('BEGIN');
  for (const [table, columns] of Object.entries(TABLES)) {
    db.exec(`CREATE TABLE ${table} (${columns.join(', ')})`);
    const insert = db.prepare(`INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`);
    for (const row of data[table]) insert.run(...columns.map((c) => coerce(c, row[c])));
  }
  db.exec('COMMIT');
  return new Warehouse(db);
}

function readCsvObjects(file) {
  const { header, rows } = parseCsv(fs.readFileSync(file, 'utf8'));
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r.fields[i]])));
}

// Builds the warehouse from the files written by `npm run data:build`.
export function createWarehouseFromProcessed(dir = DEFAULT_OUT, params = DEFAULT_PARAMS) {
  const read = (name) => readCsvObjects(path.join(dir, name));
  return createWarehouse({
    observations: read('observations_clean.csv'),
    quarantine: read('quarantine_ledger.csv'),
    reports: read('reports.csv'),
    queryHistory: read('sim_query_history.csv'),
    metering: read('sim_warehouse_metering_history.csv'),
    params,
  });
}
