import {
  LATENCY_ALERT_SEC,
  LATENCY_CEILING_SEC,
  NUMERIC_COLUMNS,
  OBSERVATION_EPOCH_MS,
  ORPHAN_KIND,
  OWNER_EMAIL_PATTERN,
  OWNER_MISSING_TOKENS,
  OWNER_SENTINEL_TOKENS,
  QUARANTINE,
  REFRESH_STATUS,
  REPORT_SPACING_MS,
  REQUIRED_COLUMNS,
  WINDOW_MS,
} from './rules.js';

const NUMBER_PATTERN = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

export function parseNumber(raw) {
  const s = String(raw ?? '').trim();
  if (!NUMBER_PATTERN.test(s)) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

// Returns { email, orphanKind }. email is lower-cased; orphanKind is null when the owner is usable.
export function normalizeOwner(raw) {
  const s = String(raw ?? '').trim();
  const key = s.toLowerCase();
  if (OWNER_MISSING_TOKENS.has(key)) return { email: null, orphanKind: ORPHAN_KIND.MISSING };
  if (OWNER_SENTINEL_TOKENS.has(key)) return { email: null, orphanKind: ORPHAN_KIND.SENTINEL };
  if (!OWNER_EMAIL_PATTERN.test(s)) return { email: null, orphanKind: ORPHAN_KIND.INVALID };
  return { email: key, orphanKind: null };
}

export function normalizeStatus(raw) {
  const key = String(raw ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return REFRESH_STATUS.includes(key) ? { status: key, recognised: true } : { status: 'UNKNOWN', recognised: false };
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

// Turns raw CSV records into { clean, quarantine }.
// Invariant (asserted in tests and in the DQ report): clean.length + quarantine.length === records.length.
export function cleanObservations({ header, rows }) {
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length > 0) throw new Error(`CSV is missing required columns: ${missing.join(', ')}`);
  const at = Object.fromEntries(header.map((h, i) => [h, i]));

  const occurrence = new Map(); // report_id -> how many rows seen so far (drives the synthetic timestamp)
  const firstSeen = new Map(); // report_id -> order of first appearance
  const seenKeys = new Set();
  const clean = [];
  const quarantine = [];

  for (const rec of rows) {
    const reasons = [];
    const raw = rec.fields;
    const rawRecord = raw.join(',');

    if (raw.length !== header.length) {
      quarantine.push({
        source_row: rec.line,
        report_id: null,
        reason_codes: QUARANTINE.MALFORMED_ROW,
        reason_detail: `expected ${header.length} fields, got ${raw.length}`,
        raw_record: rawRecord,
      });
      continue;
    }

    const get = (col) => raw[at[col]];
    const reportId = get('report_id').trim().toUpperCase();
    if (reportId === '') reasons.push([QUARANTINE.MISSING_REPORT_ID, 'report_id is empty']);

    const key = raw.map((v) => v.trim()).join('\u0001');
    if (seenKeys.has(key)) reasons.push([QUARANTINE.DUPLICATE_ROW, 'identical to an earlier row']);
    seenKeys.add(key);

    const num = {};
    for (const { col, integer } of NUMERIC_COLUMNS) {
      const value = parseNumber(get(col));
      if (Number.isNaN(value)) {
        reasons.push([QUARANTINE.NON_NUMERIC, `${col}=${JSON.stringify(get(col))}`]);
      } else if (integer && !Number.isInteger(value)) {
        reasons.push([QUARANTINE.NON_INTEGER, `${col}=${value}`]);
      } else if (value < 0) {
        const code = col === 'snowflake_credits_consumed' ? QUARANTINE.NEGATIVE_CREDITS : QUARANTINE.NEGATIVE_VALUE;
        reasons.push([code, `${col}=${value}`]);
      }
      num[col] = value;
    }

    if (reasons.length > 0) {
      quarantine.push({
        source_row: rec.line,
        report_id: reportId || null,
        reason_codes: [...new Set(reasons.map((r) => r[0]))].join('|'),
        reason_detail: reasons.map((r) => r[1]).join('; '),
        raw_record: rawRecord,
      });
      // A quarantined row still occupies its slot on the timeline, so later rows keep stable timestamps.
      if (reportId !== '') {
        occurrence.set(reportId, (occurrence.get(reportId) ?? 0) + 1);
        if (!firstSeen.has(reportId)) firstSeen.set(reportId, firstSeen.size);
      }
      continue;
    }

    const k = occurrence.get(reportId) ?? 0;
    occurrence.set(reportId, k + 1);
    if (!firstSeen.has(reportId)) firstSeen.set(reportId, firstSeen.size);
    const observedAt = new Date(OBSERVATION_EPOCH_MS + k * WINDOW_MS + firstSeen.get(reportId) * REPORT_SPACING_MS);

    const owner = normalizeOwner(get('owner_email'));
    const status = normalizeStatus(get('last_refresh_status'));
    const name = get('report_name').trim();
    const latency = num.avg_load_time_sec;

    clean.push({
      observation_id: `${reportId}:${pad(k + 1, 3)}`,
      source_row: rec.line,
      report_id: reportId,
      report_name: name === '' ? null : name,
      owner_email: owner.email,
      last_refresh_status: status.status,
      monthly_active_views: num.monthly_active_views,
      snowflake_credits_consumed: num.snowflake_credits_consumed,
      avg_load_time_sec: latency,
      aws_hosting_cost_usd: num.aws_hosting_cost_usd,
      query_count_last_30d: num.query_count_last_30d,
      concurrent_user_peak: num.concurrent_user_peak,
      observed_at: observedAt.toISOString(),
      is_orphan: owner.orphanKind !== null,
      orphan_kind: owner.orphanKind,
      status_unknown: status.status === 'UNKNOWN',
      status_unrecognised: !status.recognised,
      zero_views: num.monthly_active_views === 0,
      latency_breach: latency > LATENCY_ALERT_SEC,
      latency_at_ceiling: latency >= LATENCY_CEILING_SEC,
      concurrency_exceeds_views: num.concurrent_user_peak > num.monthly_active_views,
    });
  }

  return { clean, quarantine };
}

export const CLEAN_COLUMNS = [
  'observation_id',
  'source_row',
  'report_id',
  'report_name',
  'owner_email',
  'last_refresh_status',
  'monthly_active_views',
  'snowflake_credits_consumed',
  'avg_load_time_sec',
  'aws_hosting_cost_usd',
  'query_count_last_30d',
  'concurrent_user_peak',
  'observed_at',
  'is_orphan',
  'orphan_kind',
  'status_unknown',
  'status_unrecognised',
  'zero_views',
  'latency_breach',
  'latency_at_ceiling',
  'concurrency_exceeds_views',
];

export const QUARANTINE_COLUMNS = ['source_row', 'report_id', 'reason_codes', 'reason_detail', 'raw_record'];
