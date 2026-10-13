// Pure alert logic: observations in, alerts out. No timers, no network, no clock, so it can be tested exactly.
//
// For each (report, alert type) the engine tracks whether the condition is currently "active":
//   TRIGGERED  the condition appears
//   ESCALATED  it got worse than the last thing we told anyone (shown immediately, ignores the cooldown)
//   REPEATED   it is still true after the cooldown; says how many readings were held back
//   RESOLVED   it cleared
// Readings that change nothing the reader needs to know are counted as suppressed, never dropped silently.
// RESOLVED needs `clearAfter` consecutive clear readings so a flapping report does not spam trigger/resolve pairs.

import {
  DEFAULT_CLEAR_AFTER_READINGS,
  DEFAULT_COOLDOWN_MS,
  FAILURE_STATUSES,
  FAILURE_STREAK_CRITICAL,
  LATENCY_ALERT_SEC,
  SEVERITY_RANK,
  latencySeverity,
} from './rules.js';

const keyOf = (reportId, type) => `${reportId}|${type}`;

export function createAlertEngine({ cooldownMs = DEFAULT_COOLDOWN_MS, clearAfter = DEFAULT_CLEAR_AFTER_READINGS } = {}) {
  const active = new Map(); // key -> { severity, since, lastEmitMs, suppressed }
  const failureStreak = new Map(); // report_id -> consecutive failed refreshes
  const stats = {
    observations: 0,
    breaches: { LATENCY: 0, REFRESH_FAILURE: 0 }, // readings where the condition was true
    emitted: { TRIGGERED: 0, ESCALATED: 0, REPEATED: 0, RESOLVED: 0 },
    suppressed: { LATENCY: 0, REFRESH_FAILURE: 0 },
  };

  function evaluate(type, event, severity, t, out) {
    const key = keyOf(event.report_id, type);
    const state = active.get(key);

    if (severity === null) {
      if (state) {
        state.clearReadings++;
        if (state.clearReadings >= clearAfter) {
          out.push(build('RESOLVED', type, event, state.severity, state, t));
          active.delete(key);
        }
      }
      return;
    }

    stats.breaches[type]++;
    if (state) state.clearReadings = 0;
    if (!state) {
      active.set(key, { severity, since: event.observed_at, lastEmitMs: t, suppressed: 0, clearReadings: 0 });
      out.push(build('TRIGGERED', type, event, severity, { suppressed: 0 }, t));
    } else if (SEVERITY_RANK[severity] > SEVERITY_RANK[state.severity]) {
      out.push(build('ESCALATED', type, event, severity, state, t));
      state.severity = severity;
      state.lastEmitMs = t;
      state.suppressed = 0;
    } else if (t - state.lastEmitMs >= cooldownMs) {
      out.push(build('REPEATED', type, event, severity, state, t));
      state.severity = severity;
      state.lastEmitMs = t;
      state.suppressed = 0;
    } else {
      state.suppressed++;
      stats.suppressed[type]++;
    }
  }

  function build(lifecycle, type, event, severity, state, t) {
    stats.emitted[lifecycle]++;
    const alert = {
      alert_type: type,
      lifecycle,
      severity,
      report_id: event.report_id,
      report_name: event.report_name ?? null,
      observation_id: event.observation_id,
      observed_at: event.observed_at,
      suppressed_since_last: state.suppressed ?? 0,
      message: messageFor(lifecycle, type, event, severity),
    };
    if (type === 'LATENCY') {
      alert.value = event.avg_load_time_sec;
      alert.threshold = LATENCY_ALERT_SEC;
    } else {
      alert.value = event.last_refresh_status;
      if (lifecycle !== 'RESOLVED') alert.consecutive_failures = failureStreak.get(event.report_id) ?? 1;
    }
    if (lifecycle === 'RESOLVED') alert.active_for_ms = t - Date.parse(state.since);
    return alert;
  }

  return {
    // Feed one observation (in time order). Returns the alerts it produced, possibly none.
    process(event) {
      stats.observations++;
      const t = Date.parse(event.observed_at);
      const out = [];

      evaluate('LATENCY', event, latencySeverity(event.avg_load_time_sec), t, out);

      const status = event.last_refresh_status;
      if (FAILURE_STATUSES.has(status)) {
        const streak = (failureStreak.get(event.report_id) ?? 0) + 1;
        failureStreak.set(event.report_id, streak);
        evaluate('REFRESH_FAILURE', event, streak >= FAILURE_STREAK_CRITICAL ? 'critical' : 'high', t, out);
      } else if (status === 'SUCCESS') {
        failureStreak.delete(event.report_id);
        evaluate('REFRESH_FAILURE', event, null, t, out);
      } // UNKNOWN: we cannot say it failed or recovered, so state is left untouched
      return out;
    },

    // Alerts that are open right now.
    active() {
      return [...active.entries()].map(([key, s]) => {
        const [report_id, type] = key.split('|');
        return { report_id, alert_type: type, severity: s.severity, since: s.since, suppressed_since_last: s.suppressed };
      });
    },

    stats: () => structuredClone(stats),
  };
}

function messageFor(lifecycle, type, event, severity) {
  const who = `${event.report_id}${event.report_name ? ` (${event.report_name})` : ''}`;
  if (type === 'LATENCY') {
    const what = `load time ${event.avg_load_time_sec} s`;
    if (lifecycle === 'RESOLVED') return `${who} is back under ${LATENCY_ALERT_SEC} s (${what})`;
    return `${who} ${what} is over ${LATENCY_ALERT_SEC} s (${severity})`;
  }
  const status = event.last_refresh_status === 'TIMED_OUT' ? 'timed out' : 'failed';
  if (lifecycle === 'RESOLVED') return `${who} refreshed successfully again`;
  return `${who} refresh ${status} (${severity})`;
}
