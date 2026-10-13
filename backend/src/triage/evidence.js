// Builds the evidence pack for one alert: a small set of numbered datapoints that a suggestion may cite, and that the validator
// checks every citation against. Everything the model sees comes from here, so what is left out matters as much as what is in:
//
//   - No owner emails and no report names. They are personal data (emails) and free text controlled by whoever authored the data
//     (names), which is a prompt-injection channel. Report ids are enough, and ownership is a yes/no fact.
//   - No cost data. Triage is shown to every role, and viewers must never receive cost (decision D14).
//   - Nothing from after the alert. The replay data is static, so naive code would explain a past alert using readings that had not
//     happened yet; evidence is cut off at the alert's own reading.

const OBSERVATION_LIMIT = 8;

export function buildEvidence({ alert, store, observationLimit = OBSERVATION_LIMIT }) {
  const history = store.observationHistory(alert.report_id);
  // Replayed alerts carry shifted ids like "RPT_201:004@c2"; the reading itself is the part before the "@".
  const baseId = String(alert.observation_id ?? '').split('@')[0];
  const at = history.findIndex((o) => o.observation_id === baseId);
  const upToAlert = at >= 0 ? history.slice(0, at + 1) : history;
  const newestFirst = upToAlert.slice(-observationLimit).reverse();
  const latest = upToAlert[upToAlert.length - 1];
  const isFailure = (o) => o.last_refresh_status === 'FAILED' || o.last_refresh_status === 'TIMED_OUT';

  const items = {
    A: {
      label: 'The alert being explained',
      fields: {
        alert_type: alert.alert_type,
        lifecycle: alert.lifecycle,
        severity: alert.severity,
        report_id: alert.report_id,
        value: alert.value,
        ...(alert.threshold !== undefined && { threshold: alert.threshold }),
        ...(alert.consecutive_failures !== undefined && { consecutive_failures: alert.consecutive_failures }),
      },
    },
    R: {
      label: 'The report up to the time of the alert',
      fields: {
        report_id: alert.report_id,
        readings_so_far: upToAlert.length,
        failed_refreshes_so_far: upToAlert.filter(isFailure).length,
        slow_readings_so_far: upToAlert.filter((o) => o.latency_breach === 1 || o.latency_breach === true).length,
        owner_on_record_at_alert: Boolean(latest && latest.owner_email),
      },
    },
    F: { label: 'Fleet-wide baselines across every report', fields: { ...store.fleetBaselines() } },
  };

  newestFirst.forEach((o, i) => {
    items[`O${i + 1}`] = {
      label: i === 0 ? 'The reading that raised the alert' : `The reading ${i} before it`,
      fields: {
        reading: o.observation_id,
        last_refresh_status: o.last_refresh_status,
        avg_load_time_sec: o.avg_load_time_sec,
        query_count_last_30d: o.query_count_last_30d,
        concurrent_user_peak: o.concurrent_user_peak,
        monthly_active_views: o.monthly_active_views,
      },
    };
  });

  return { items, order: Object.keys(items), observation_count: newestFirst.length };
}

// All numbers that appear anywhere in the pack, for the "no invented numbers" check.
export function numbersInEvidence(evidence) {
  const out = new Set();
  for (const item of Object.values(evidence.items)) {
    for (const v of Object.values(item.fields)) if (typeof v === 'number' && Number.isFinite(v)) out.add(v);
  }
  return out;
}
