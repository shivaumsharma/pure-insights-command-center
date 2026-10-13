// Builds simulated Snowflake ACCOUNT_USAGE tables from the clean observations.
//
// IMPORTANT (read before quoting any number from these tables):
//  - They are DERIVED from the CSV, not captured from a real Snowflake account.
//  - WAREHOUSE_METERING_HISTORY credits are the CSV credits summed per warehouse-hour, so warehouse totals
//    match the CSV by construction. That match proves nothing on its own.
//  - QUERY_HISTORY elapsed time is query_count x avg_load_time. It is independent of the CSV credits column,
//    so splitting warehouse credits by query workload (Phase 2) will NOT reproduce each report's CSV credits.
//    That gap is intended: it is the finding the reconciliation step reports.
//  - QUERY_HISTORY is pre-aggregated to one row per report per hour (with QUERY_COUNT), not one row per query.

import { WAREHOUSES, WINDOW_MS } from './rules.js';

export const QUERY_HISTORY_COLUMNS = [
  'query_id',
  'query_tag',
  'warehouse_name',
  'start_time',
  'total_elapsed_time_ms',
  'query_count',
  'execution_status',
];

export const METERING_COLUMNS = [
  'start_time',
  'end_time',
  'warehouse_id',
  'warehouse_name',
  'credits_used_compute',
  'credits_used_cloud_services',
  'credits_used',
];

// FNV-1a so the report -> warehouse assignment is stable across runs and machines.
export function warehouseFor(reportId) {
  let h = 0x811c9dc5;
  for (let i = 0; i < reportId.length; i++) {
    h ^= reportId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return WAREHOUSES[h % WAREHOUSES.length];
}

const STATUS_MAP = { SUCCESS: 'SUCCESS', FAILED: 'FAIL', TIMED_OUT: 'FAIL_TIMEOUT', UNKNOWN: 'UNKNOWN' };

export function buildQueryHistory(clean) {
  return clean.map((o) => ({
    query_id: `Q-${String(o.source_row).padStart(6, '0')}`,
    query_tag: `report:${o.report_id}`,
    warehouse_name: warehouseFor(o.report_id),
    start_time: o.observed_at,
    total_elapsed_time_ms: Math.round(o.query_count_last_30d * o.avg_load_time_sec * 1000),
    query_count: o.query_count_last_30d,
    execution_status: STATUS_MAP[o.last_refresh_status],
  }));
}

export function buildMetering(clean) {
  const buckets = new Map();
  for (const o of clean) {
    const wh = warehouseFor(o.report_id);
    const windowStart = Math.floor(Date.parse(o.observed_at) / WINDOW_MS) * WINDOW_MS;
    const key = `${windowStart}|${wh}`;
    const b = buckets.get(key) ?? { windowStart, wh, credits: 0 };
    b.credits += o.snowflake_credits_consumed;
    buckets.set(key, b);
  }

  return [...buckets.values()]
    .sort((a, b) => a.windowStart - b.windowStart || a.wh.localeCompare(b.wh))
    .map((b) => {
      const credits = Math.round(b.credits * 1e6) / 1e6;
      return {
        start_time: new Date(b.windowStart).toISOString(),
        end_time: new Date(b.windowStart + WINDOW_MS).toISOString(),
        warehouse_id: WAREHOUSES.indexOf(b.wh) + 1,
        warehouse_name: b.wh,
        credits_used_compute: credits,
        credits_used_cloud_services: 0, // the source has no cloud-services split; kept for schema fidelity
        credits_used: credits,
      };
    });
}
