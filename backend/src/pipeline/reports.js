// Report-level roll-up of the clean observations. This is what the orphaned-reports view will read.
//
// Owner is recorded per observation in the source data (every report shows several different owners
// across its rows), so a report is "currently orphaned" when its LATEST clean observation has no usable
// owner. The most recent known owner is kept as a suggestion for reassignment.

export const REPORT_COLUMNS = [
  'report_id',
  'report_name',
  'observation_count',
  'first_observed_at',
  'last_observed_at',
  'last_refresh_status',
  'current_owner_email',
  'last_known_owner_email',
  'is_orphaned',
  'orphan_observation_count',
  'distinct_owner_count',
];

export function buildReports(clean) {
  const groups = new Map();
  for (const obs of clean) {
    if (!groups.has(obs.report_id)) groups.set(obs.report_id, []);
    groups.get(obs.report_id).push(obs);
  }

  const reports = [];
  for (const [reportId, obs] of groups) {
    obs.sort((a, b) => (a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0));
    const latest = obs[obs.length - 1];
    const owners = obs.map((o) => o.owner_email).filter(Boolean);
    reports.push({
      report_id: reportId,
      report_name: latest.report_name,
      observation_count: obs.length,
      first_observed_at: obs[0].observed_at,
      last_observed_at: latest.observed_at,
      last_refresh_status: latest.last_refresh_status,
      current_owner_email: latest.owner_email,
      last_known_owner_email: owners.length > 0 ? owners[owners.length - 1] : null,
      is_orphaned: latest.owner_email === null,
      orphan_observation_count: obs.filter((o) => o.is_orphan).length,
      distinct_owner_count: new Set(owners).size,
    });
  }
  return reports;
}
