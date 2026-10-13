// What the data can and cannot support. Each cause kind has a mechanical test against the evidence pack. A suggestion that claims a
// cause the test says is false is CONTRADICTED by the data; a claim that cannot be tested (kind OTHER) goes to a person.
//
// These are deliberately simple, explainable thresholds, not a model. They are my choices, recorded in decision D33.

export const SLOW_WINDOW = 5; // look at this many latest readings for "recurring slowness"
export const SLOW_MIN = 3; // ...and call it recurring when at least this many were over the limit
export const FAILURE_MIN = 2; // consecutive failed or timed-out refreshes that count as "repeated"

const num = (ev, id, field) => {
  const v = ev.items[id]?.fields?.[field];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
};
const field = (ev, id, name) => ev.items[id]?.fields?.[name];

// Readings newest first: O1, O2, ...
export const readings = (ev) => Object.keys(ev.items).filter((k) => /^O\d+$/.test(k)).sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));

// How many of the latest SLOW_WINDOW readings were over the latency limit, and how many readings that was out of.
export function slowCount(ev) {
  const limit = num(ev, 'F', 'latency_threshold_sec');
  if (limit === null) return null;
  const window = readings(ev).slice(0, SLOW_WINDOW).map((id) => num(ev, id, 'avg_load_time_sec')).filter((v) => v !== null);
  return { slow: window.filter((v) => v > limit).length, of: window.length, limit };
}

// Consecutive failed or timed-out refreshes counted from the newest reading. UNKNOWN is skipped, as in the alert engine.
export function failureRun(ev) {
  let run = 0;
  for (const id of readings(ev)) {
    const status = field(ev, id, 'last_refresh_status');
    if (status === 'UNKNOWN') continue;
    if (status === 'FAILED' || status === 'TIMED_OUT') run++;
    else break;
  }
  return run;
}

// verdict: true = supported by the data, false = contradicted by the data, null = the evidence needed to decide is missing.
export const CAUSE_RULES = {
  HIGH_QUERY_VOLUME: {
    describe: 'the latest reading has at least as many queries as the busiest quarter of the fleet',
    requires: [['O1', 'query_count_last_30d'], ['F', 'p75_query_count_last_30d']],
    verdict(ev) {
      const a = num(ev, 'O1', 'query_count_last_30d'), b = num(ev, 'F', 'p75_query_count_last_30d');
      return a === null || b === null ? null : a >= b;
    },
  },
  HIGH_CONCURRENCY: {
    describe: 'peak concurrent users on the latest reading are at or above the busiest quarter of the fleet',
    requires: [['O1', 'concurrent_user_peak'], ['F', 'p75_concurrent_user_peak']],
    verdict(ev) {
      const a = num(ev, 'O1', 'concurrent_user_peak'), b = num(ev, 'F', 'p75_concurrent_user_peak');
      return a === null || b === null ? null : a >= b;
    },
  },
  RECURRING_SLOWNESS: {
    describe: `at least ${SLOW_MIN} of the latest ${SLOW_WINDOW} readings were over the latency limit`,
    requires: [['O1', 'avg_load_time_sec'], ['F', 'latency_threshold_sec']],
    verdict(ev) {
      const s = slowCount(ev);
      return s === null || s.of === 0 ? null : s.slow >= SLOW_MIN;
    },
  },
  REPEATED_FAILURES: {
    describe: `at least ${FAILURE_MIN} refreshes in a row failed or timed out`,
    requires: [['O1', 'last_refresh_status']],
    verdict(ev) {
      return field(ev, 'O1', 'last_refresh_status') === undefined ? null : failureRun(ev) >= FAILURE_MIN;
    },
  },
  OWNERSHIP_GAP: {
    describe: 'no owner was on record for the report at the time of the alert',
    requires: [['R', 'owner_on_record_at_alert']],
    verdict(ev) {
      const v = field(ev, 'R', 'owner_on_record_at_alert');
      return typeof v === 'boolean' ? v === false : null;
    },
  },
  // Not testable against the data: always handed to a person.
  OTHER: { describe: 'a cause the data cannot confirm or rule out', requires: [], verdict: () => null },
};

// An action is only offered when the cause that justifies it is supported. MONITOR and NONE need nothing.
export const ACTION_REQUIRES = {
  INVESTIGATE_QUERIES: (supported) => supported.has('HIGH_QUERY_VOLUME'),
  REVIEW_CAPACITY: (supported) => supported.has('HIGH_CONCURRENCY'),
  CHECK_REFRESH_SCHEDULE: (supported, ev) => supported.has('REPEATED_FAILURES') || field(ev, 'A', 'alert_type') === 'REFRESH_FAILURE',
  ASSIGN_OWNER: (supported) => supported.has('OWNERSHIP_GAP'),
  MONITOR: () => true,
  NONE: () => true,
};

// The citation a claim should carry: the (evidence, field) pairs a cause's rule reads.
export function citeFor(ev, pairs) {
  return pairs.map(([id, name]) => ({ evidence: id, field: name, value: String(field(ev, id, name)) }));
}

export { field as evidenceField, num as evidenceNumber };
