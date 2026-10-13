// Alert thresholds and severity tiers. Single source of truth; docs/decisions.md (D19) explains the choices.

export const LATENCY_ALERT_SEC = 15; // from the brief: alert when load time exceeds 15 s

// Upper bound is inclusive for the tier below it: 25.0 s is still "low", 25.1 s is "medium".
export const LATENCY_TIERS = [
  { severity: 'critical', atLeastSec: 55 }, // pinned at the 55 s ceiling in the data (looks like a cap or timeout)
  { severity: 'high', above: 35 },
  { severity: 'medium', above: 25 },
  { severity: 'low', above: LATENCY_ALERT_SEC },
];

export const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };

export function latencySeverity(sec) {
  for (const tier of LATENCY_TIERS) {
    if (tier.atLeastSec !== undefined ? sec >= tier.atLeastSec : sec > tier.above) return tier.severity;
  }
  return null;
}

// A failed or timed-out refresh is "high". Three or more in a row for the same report is "critical".
export const FAILURE_STATUSES = new Set(['FAILED', 'TIMED_OUT']);
export const FAILURE_STREAK_CRITICAL = 3;

// Time between repeat notifications for a condition that is still true, measured in EVENT time (the observation
// timestamps), not wall-clock time, so a fast replay and a live feed behave identically.
export const DEFAULT_COOLDOWN_MS = 6 * 60 * 60 * 1000;

// An alert resolves only after this many consecutive clear readings. Without it a report that dips under the
// threshold for one reading and spikes again would trigger and resolve over and over ("flapping").
export const DEFAULT_CLEAR_AFTER_READINGS = 2;

export const ALERT_TYPES = ['LATENCY', 'REFRESH_FAILURE'];
export const LIFECYCLES = ['TRIGGERED', 'ESCALATED', 'REPEATED', 'RESOLVED'];
