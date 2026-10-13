// A triager with no AI in it: it applies the same data rules the validator uses and writes the suggestion from templates.
//
// Two jobs. It is the default when no model is configured, so the feature works (and is safe) without an API key. And it is the
// control for measurement: any model's suggestions are judged by the same validator, so "is the model better than the rules?" is a
// question with an answer rather than an assumption.

import { ACTION_REQUIRES, CAUSE_RULES, citeFor, evidenceField, evidenceNumber, failureRun, slowCount } from './rules.js';

const ORDER = ['REPEATED_FAILURES', 'OWNERSHIP_GAP', 'HIGH_QUERY_VOLUME', 'HIGH_CONCURRENCY', 'RECURRING_SLOWNESS'];
const ACTION_FOR = {
  REPEATED_FAILURES: ['CHECK_REFRESH_SCHEDULE', 'Several refreshes in a row did not succeed, so the schedule and the source are the first things to check.'],
  OWNERSHIP_GAP: ['ASSIGN_OWNER', 'Nobody is on record as responsible, so the alert has no one to act on it.'],
  HIGH_QUERY_VOLUME: ['INVESTIGATE_QUERIES', 'Query volume is among the highest in the fleet, so look at what is running.'],
  HIGH_CONCURRENCY: ['REVIEW_CAPACITY', 'Many people were using it at once, so check whether capacity is enough.'],
};

function claimFor(kind, ev) {
  switch (kind) {
    case 'HIGH_QUERY_VOLUME':
      return `The latest reading had ${evidenceNumber(ev, 'O1', 'query_count_last_30d')} queries, at or above the fleet's busiest quarter (${evidenceNumber(ev, 'F', 'p75_query_count_last_30d')}).`;
    case 'HIGH_CONCURRENCY':
      return `Peak concurrent users were ${evidenceNumber(ev, 'O1', 'concurrent_user_peak')}, at or above the fleet's busiest quarter (${evidenceNumber(ev, 'F', 'p75_concurrent_user_peak')}).`;
    case 'RECURRING_SLOWNESS': {
      const s = slowCount(ev);
      return `${s.slow} of the latest ${s.of} readings were over the ${s.limit} s limit.`;
    }
    case 'REPEATED_FAILURES':
      return `${failureRun(ev)} refreshes in a row failed or timed out.`;
    default:
      return 'No owner was on record for this report at the time of the alert.';
  }
}

export const baselineTriager = {
  name: 'baseline',
  model: null,
  async triage(evidence) {
    const alert = evidence.items.A.fields;
    const causes = ORDER.filter((kind) => CAUSE_RULES[kind].verdict(evidence) === true).map((kind) => ({
      kind,
      claim: claimFor(kind, evidence),
      cites: citeFor(evidence, CAUSE_RULES[kind].requires),
      confidence: 0.8,
    }));
    const supported = new Set(causes.map((c) => c.kind));

    const actions = causes
      .filter((c) => ACTION_FOR[c.kind] && ACTION_REQUIRES[ACTION_FOR[c.kind][0]](supported, evidence))
      .map((c) => ({ kind: ACTION_FOR[c.kind][0], rationale: ACTION_FOR[c.kind][1], cites: c.cites }));
    if (actions.length === 0) actions.push({ kind: causes.length > 0 ? 'MONITOR' : 'NONE', rationale: 'Nothing in the data points to a specific fix.', cites: [] });

    const what =
      alert.alert_type === 'LATENCY'
        ? `Load time on ${alert.report_id} was ${alert.value} s against the ${alert.threshold} s limit.`
        : `The latest refresh of ${alert.report_id} did not succeed (${evidenceField(evidence, 'A', 'value')}).`;
    const why = causes.length > 0 ? ` The data supports ${causes.length === 1 ? 'one possible cause' : `${causes.length} possible causes`}.` : ' The data does not show a clear cause, so a person should take a look.';

    return {
      suggestion: { summary: what + why, causes, actions, needs_human: causes.length === 0, confidence: causes.length > 0 ? 0.8 : 0.3 },
      usage: null,
    };
  },
};
