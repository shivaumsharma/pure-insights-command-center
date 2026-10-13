const nf = new Intl.NumberFormat('en-US');
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const when = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' });

const missing = (v) => v === null || v === undefined || Number.isNaN(v);

export const fmtInt = (n) => (missing(n) ? '—' : nf.format(n));
export const fmtSec = (n) => (missing(n) ? '—' : `${Number(n).toFixed(1)} s`);
export const fmtPct = (n) => (missing(n) ? '—' : `${n}%`);
export const fmtUsd = (n) => (missing(n) ? '—' : usd.format(n));
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
// Whole numbers (counts in the reconciliation checks) stay whole; credit amounts always show two decimals.
export const fmtCredits = (n) => (missing(n) ? '—' : Number.isInteger(n) ? nf.format(n) : nf2.format(n));

export const plural = (n, one, many = `${one}s`) => `${fmtInt(n)} ${n === 1 ? one : many}`;

// Event times come from a synthetic timeline (the source data has no clock), so they are shown in UTC.
export const fmtEventTime = (iso) => (iso ? `${when.format(new Date(iso))} UTC` : '—');

export function fmtDuration(ms) {
  if (missing(ms)) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
}

export const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low'];
export const STATUS_LABEL = { SUCCESS: 'Healthy', FAILED: 'Failed', TIMED_OUT: 'Timed out', UNKNOWN: 'Unknown' };
export const LIFECYCLE_LABEL = { TRIGGERED: 'New', ESCALATED: 'Worse', REPEATED: 'Still open', RESOLVED: 'Resolved' };
export const ALERT_TYPE_LABEL = { LATENCY: 'Slow load', REFRESH_FAILURE: 'Refresh failed' };
