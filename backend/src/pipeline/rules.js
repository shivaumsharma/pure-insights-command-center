// Single source of truth for cleaning rules, thresholds and reason codes.
// Anything a reviewer might ask "why was this row treated that way?" is defined here.

export const REQUIRED_COLUMNS = [
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
];

// Numeric columns and how strictly each is validated.
export const NUMERIC_COLUMNS = [
  { col: 'monthly_active_views', integer: true },
  { col: 'snowflake_credits_consumed', integer: false },
  { col: 'avg_load_time_sec', integer: false },
  { col: 'aws_hosting_cost_usd', integer: false },
  { col: 'query_count_last_30d', integer: true },
  { col: 'concurrent_user_peak', integer: true },
];

// Reasons a whole observation is removed from the clean store (kept in the quarantine ledger).
export const QUARANTINE = {
  MALFORMED_ROW: 'MALFORMED_ROW',
  MISSING_REPORT_ID: 'MISSING_REPORT_ID',
  NON_NUMERIC: 'NON_NUMERIC',
  NON_INTEGER: 'NON_INTEGER',
  NEGATIVE_CREDITS: 'NEGATIVE_CREDITS',
  NEGATIVE_VALUE: 'NEGATIVE_VALUE',
  DUPLICATE_ROW: 'DUPLICATE_ROW',
};

// Owner values that mean "nobody owns this report".
export const OWNER_MISSING_TOKENS = new Set(['', 'nan', 'null', 'none', 'n/a', 'na', 'undefined']);
export const OWNER_SENTINEL_TOKENS = new Set(['orphaned_report']);
export const OWNER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const ORPHAN_KIND = {
  MISSING: 'MISSING', // empty / NaN / null token
  SENTINEL: 'SENTINEL', // explicit ORPHANED_REPORT marker
  INVALID: 'INVALID', // present but not a usable email address
};

export const REFRESH_STATUS = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];

// Brief: alert when dashboard load latency exceeds 15 s. The data tops out at exactly 55 s,
// which looks like a ceiling (probably a cap or timeout), so it is reported separately.
export const LATENCY_ALERT_SEC = 15;
export const LATENCY_CEILING_SEC = 55;

// Synthetic timeline. The CSV has no timestamps, so each report's k-th row is treated as its
// k-th hourly observation. See docs/decisions.md (D3).
export const OBSERVATION_EPOCH_MS = Date.UTC(2026, 8, 1, 0, 0, 0); // 2026-09-01T00:00:00Z
export const WINDOW_MS = 60 * 60 * 1000;
export const REPORT_SPACING_MS = 30 * 1000;

export const WAREHOUSES = ['PI_ADHOC_WH', 'PI_BATCH_WH', 'PI_EXEC_WH', 'PI_REPORTING_WH'];
