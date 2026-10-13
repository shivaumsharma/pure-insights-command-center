// Data-quality report: what was found, what was done about it, before and after.
// Output is deterministic (no timestamps) so it can be diffed between runs.

import { LATENCY_ALERT_SEC, LATENCY_CEILING_SEC } from './rules.js';

const r2 = (n) => Math.round(n * 100) / 100;
const count = (arr, pred) => arr.reduce((n, x) => n + (pred(x) ? 1 : 0), 0);
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

export function buildDqReport({ sourceFile, rowsIn, clean, quarantine, reports, rawCreditsSum }) {
  const byReason = {};
  for (const q of quarantine) {
    for (const code of q.reason_codes.split('|')) byReason[code] = (byReason[code] ?? 0) + 1;
  }

  const statusCounts = {};
  for (const o of clean) statusCounts[o.last_refresh_status] = (statusCounts[o.last_refresh_status] ?? 0) + 1;

  const latencies = clean.map((o) => o.avg_load_time_sec);
  const cleanCredits = sum(clean, (o) => o.snowflake_credits_consumed);

  return {
    source_file: sourceFile,
    rows: {
      in: rowsIn,
      clean: clean.length,
      quarantined: quarantine.length,
      conserved: clean.length + quarantine.length === rowsIn,
    },
    quarantine_by_reason: byReason,
    quarantine_note: 'A row with several problems is counted once per reason, so reason counts can exceed quarantined rows.',
    flags_on_clean_rows: {
      orphan_observations: count(clean, (o) => o.is_orphan),
      orphan_missing: count(clean, (o) => o.orphan_kind === 'MISSING'),
      orphan_sentinel: count(clean, (o) => o.orphan_kind === 'SENTINEL'),
      orphan_invalid_email: count(clean, (o) => o.orphan_kind === 'INVALID'),
      status_unknown: count(clean, (o) => o.status_unknown),
      status_unrecognised: count(clean, (o) => o.status_unrecognised),
      zero_views: count(clean, (o) => o.zero_views),
      zero_views_with_cost: count(clean, (o) => o.zero_views && (o.snowflake_credits_consumed > 0 || o.aws_hosting_cost_usd > 0)),
      concurrency_exceeds_views: count(clean, (o) => o.concurrency_exceeds_views),
    },
    latency: {
      alert_threshold_sec: LATENCY_ALERT_SEC,
      breaches: count(clean, (o) => o.latency_breach),
      breach_pct_of_clean: r2((100 * count(clean, (o) => o.latency_breach)) / Math.max(clean.length, 1)),
      at_ceiling_sec: LATENCY_CEILING_SEC,
      at_ceiling: count(clean, (o) => o.latency_at_ceiling),
      max_sec: latencies.length > 0 ? Math.max(...latencies) : null,
    },
    refresh_status_clean: statusCounts,
    reports: {
      total: reports.length,
      currently_orphaned: count(reports, (r) => r.is_orphaned),
      with_any_orphan_observation: count(reports, (r) => r.orphan_observation_count > 0),
      with_more_than_one_owner: count(reports, (r) => r.distinct_owner_count > 1),
    },
    credits: {
      source_sum_of_parseable_values: r2(rawCreditsSum),
      clean_sum: r2(cleanCredits),
      quarantine_effect: r2(cleanCredits - rawCreditsSum),
    },
  };
}

export function renderDqMarkdown(d) {
  const L = [];
  const table = (head, rows) => {
    L.push(`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`);
    for (const row of rows) L.push(`| ${row.join(' | ')} |`);
    L.push('');
  };

  L.push('# Data-quality report', '', `Source: \`${d.source_file}\``, '');
  L.push('## Row outcome', '');
  table(['Measure', 'Rows'], [
    ['In', d.rows.in],
    ['Clean', d.rows.clean],
    ['Quarantined', d.rows.quarantined],
    ['Clean + quarantined = in', d.rows.conserved ? 'yes' : '**NO - rows were lost**'],
  ]);

  L.push('## Quarantined (removed from the clean store, kept in the ledger)', '');
  const reasons = Object.entries(d.quarantine_by_reason);
  table(['Reason', 'Rows'], reasons.length > 0 ? reasons.map(([k, v]) => [`\`${k}\``, v]) : [['none', 0]]);
  L.push(`_${d.quarantine_note}_`, '');

  const f = d.flags_on_clean_rows;
  L.push('## Flagged but kept (clean rows)', '');
  table(['Flag', 'Rows', 'Why it is kept'], [
    ['Orphan observation (no owner)', f.orphan_observations, 'The report still costs money; ownership is a finding, not a reason to drop it'],
    ['- owner empty / NaN', f.orphan_missing, ''],
    ['- `ORPHANED_REPORT` marker', f.orphan_sentinel, ''],
    ['- invalid email', f.orphan_invalid_email, ''],
    ['Refresh status UNKNOWN', f.status_unknown, 'Unknown is not a failure; excluded from failure alerts'],
    ['Zero monthly views', f.zero_views, 'Unit cost per view is undefined; handled in the cost SQL'],
    ['- of which still incur cost', f.zero_views_with_cost, 'Idle spend'],
    ['Peak concurrent users > monthly views', f.concurrency_exceeds_views, 'Implausible combination; surfaced as a warning'],
  ]);

  L.push('## Latency', '');
  table(['Measure', 'Value'], [
    [`Rows over ${d.latency.alert_threshold_sec} s`, `${d.latency.breaches} (${d.latency.breach_pct_of_clean}% of clean)`],
    [`Rows at ${d.latency.at_ceiling_sec} s (looks like a cap)`, d.latency.at_ceiling],
    ['Maximum', `${d.latency.max_sec} s`],
  ]);

  L.push('## Reports', '');
  table(['Measure', 'Reports'], [
    ['With clean observations', d.reports.total],
    ['Currently orphaned (latest observation has no owner)', d.reports.currently_orphaned],
    ['With at least one orphan observation', d.reports.with_any_orphan_observation],
    ['With more than one distinct owner', d.reports.with_more_than_one_owner],
  ]);

  L.push('## Credits before and after', '');
  table(['Measure', 'Credits'], [
    ['Sum of all parseable source values', d.credits.source_sum_of_parseable_values],
    ['Sum in clean store', d.credits.clean_sum],
    ['Change caused by quarantine', d.credits.quarantine_effect],
  ]);
  L.push('_Positive means the quarantined rows were net-negative (refund-like), so the clean total is higher than the source total._', '');

  return L.join('\n');
}
