// Phase 1 entry point: raw CSV -> clean store, quarantine ledger, report roll-up,
// simulated Snowflake tables and a data-quality report.
//
//   node backend/src/pipeline/pipeline.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLEAN_COLUMNS, QUARANTINE_COLUMNS, cleanObservations, parseNumber } from './clean.js';
import { parseCsv, toCsv } from './csv.js';
import { buildDqReport, renderDqMarkdown } from './dq-report.js';
import { REPORT_COLUMNS, buildReports } from './reports.js';
import { METERING_COLUMNS, QUERY_HISTORY_COLUMNS, buildMetering, buildQueryHistory } from './simulate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const DEFAULT_RAW = path.join(ROOT, 'data/raw/Case_Study_3_Pure_Insights_Monitoring.csv');
export const DEFAULT_OUT = path.join(ROOT, 'data/processed');

export function runPipeline({ rawPath = DEFAULT_RAW, outDir = DEFAULT_OUT } = {}) {
  const parsed = parseCsv(fs.readFileSync(rawPath, 'utf8'));
  const { clean, quarantine } = cleanObservations(parsed);
  const reports = buildReports(clean);
  const queryHistory = buildQueryHistory(clean);
  const metering = buildMetering(clean);

  const creditsAt = parsed.header.indexOf('snowflake_credits_consumed');
  const rawCreditsSum = parsed.rows.reduce((s, r) => {
    const v = parseNumber(r.fields[creditsAt]);
    return Number.isNaN(v) ? s : s + v;
  }, 0);

  const dq = buildDqReport({
    sourceFile: path.basename(rawPath),
    rowsIn: parsed.rows.length,
    clean,
    quarantine,
    reports,
    rawCreditsSum,
  });

  fs.mkdirSync(outDir, { recursive: true });
  const write = (name, content) => fs.writeFileSync(path.join(outDir, name), content);
  write('observations_clean.csv', toCsv(CLEAN_COLUMNS, clean));
  write('quarantine_ledger.csv', toCsv(QUARANTINE_COLUMNS, quarantine));
  write('reports.csv', toCsv(REPORT_COLUMNS, reports));
  write('sim_query_history.csv', toCsv(QUERY_HISTORY_COLUMNS, queryHistory));
  write('sim_warehouse_metering_history.csv', toCsv(METERING_COLUMNS, metering));
  write('dq_report.json', JSON.stringify(dq, null, 2) + '\n');
  write('dq_report.md', renderDqMarkdown(dq) + '\n');

  return { clean, quarantine, reports, queryHistory, metering, dq };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { dq } = runPipeline();
  console.log(
    `rows in ${dq.rows.in} | clean ${dq.rows.clean} | quarantined ${dq.rows.quarantined} | conserved ${dq.rows.conserved}`,
  );
  console.log('quarantine by reason:', JSON.stringify(dq.quarantine_by_reason));
  console.log(`reports ${dq.reports.total} | currently orphaned ${dq.reports.currently_orphaned}`);
  console.log(`outputs written to ${DEFAULT_OUT}`);
}
