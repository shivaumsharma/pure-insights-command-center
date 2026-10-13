// A small, fully worked evidence pack so every validator expectation can be checked by hand.
//
// RPT_9 raised a LATENCY alert at 41.2 s. Facts (derived from the numbers below):
//   - HIGH_QUERY_VOLUME is TRUE: 21,000 queries >= the fleet's busiest quarter (18,898)
//   - HIGH_CONCURRENCY is FALSE: 40 users < 112
//   - RECURRING_SLOWNESS is TRUE: 4 of the latest 5 readings (41.2, 30.1, 33.3, 16.0) are over 15 s, one (12.0) is not
//   - REPEATED_FAILURES is FALSE: the latest refresh succeeded
//   - OWNERSHIP_GAP is FALSE: an owner is on record

export function pack(overrides = {}) {
  const items = {
    A: { label: 'The alert being explained', fields: { alert_type: 'LATENCY', lifecycle: 'TRIGGERED', severity: 'high', report_id: 'RPT_9', value: 41.2, threshold: 15 } },
    R: { label: 'The report up to the time of the alert', fields: { report_id: 'RPT_9', readings_so_far: 12, failed_refreshes_so_far: 3, slow_readings_so_far: 9, owner_on_record_at_alert: true } },
    F: { label: 'Fleet-wide baselines', fields: { readings: 1976, median_load_time_sec: 27.6, p75_query_count_last_30d: 18898, p75_concurrent_user_peak: 112, latency_threshold_sec: 15, slow_readings_pct: 74.4 } },
  };
  const readings = [
    { status: 'SUCCESS', load: 41.2, queries: 21000, users: 40 },
    { status: 'SUCCESS', load: 30.1, queries: 5000, users: 60 },
    { status: 'SUCCESS', load: 12.0, queries: 7000, users: 20 },
    { status: 'SUCCESS', load: 33.3, queries: 9000, users: 30 },
    { status: 'SUCCESS', load: 16.0, queries: 4000, users: 25 },
  ];
  readings.forEach((r, i) => {
    items[`O${i + 1}`] = {
      label: `reading ${i + 1}`,
      fields: { reading: `RPT_9:${String(12 - i).padStart(3, '0')}`, last_refresh_status: r.status, avg_load_time_sec: r.load, query_count_last_30d: r.queries, concurrent_user_peak: r.users, monthly_active_views: 500 },
    };
  });
  for (const [id, fields] of Object.entries(overrides)) {
    if (fields === null) delete items[id];
    else items[id] = { ...(items[id] ?? { label: id }), fields: { ...(items[id]?.fields ?? {}), ...fields } };
  }
  return { items, order: Object.keys(items), observation_count: readings.length };
}

const cite = (evidence, field, value) => ({ evidence, field, value: String(value) });

// A suggestion that is entirely true and fully cited: the validator must TRUST it.
export function good() {
  return {
    summary: 'Load time on RPT_9 was 41.2 s against the 15 s limit. The data supports 2 possible causes.',
    causes: [
      {
        kind: 'HIGH_QUERY_VOLUME',
        claim: "The latest reading had 21000 queries, at or above the fleet's busiest quarter (18898).",
        cites: [cite('O1', 'query_count_last_30d', 21000), cite('F', 'p75_query_count_last_30d', 18898)],
        confidence: 0.8,
      },
      {
        kind: 'RECURRING_SLOWNESS',
        claim: '4 of the latest 5 readings were over the 15 s limit.',
        cites: [cite('O1', 'avg_load_time_sec', 41.2), cite('F', 'latency_threshold_sec', 15)],
        confidence: 0.8,
      },
    ],
    actions: [{ kind: 'INVESTIGATE_QUERIES', rationale: 'Query volume is among the highest in the fleet, so look at what is running.', cites: [cite('O1', 'query_count_last_30d', 21000)] }],
    needs_human: false,
    confidence: 0.8,
  };
}

export { cite };
