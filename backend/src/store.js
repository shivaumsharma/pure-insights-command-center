// In-memory read model for the API. Loads the Phase 1 outputs and runs the Phase 2 cost SQL once at startup.
// The only mutable state is the owner-assignment overlay (and its audit trail), persisted to a small JSON file.

import fs from 'node:fs';
import path from 'node:path';
import { runCostSuite } from './cost/cost-suite.js';
import { LATENCY_ALERT_SEC } from './pipeline/rules.js';
import { DEFAULT_PARAMS, createWarehouseFromProcessed } from './warehouse/local-warehouse.js';

const bool = (v) => v === 1 || v === true;
const isFailure = (status) => status === 'FAILED' || status === 'TIMED_OUT';
const pct = (n, d) => (d === 0 ? 0 : Math.round((1000 * n) / d) / 10);

export function loadStore({ dataDir, runtimeDir, params = DEFAULT_PARAMS, now = () => new Date() }) {
  const wh = createWarehouseFromProcessed(dataDir, params);
  const cost = runCostSuite(wh);
  const reports = wh.query('SELECT * FROM core.reports ORDER BY report_id');
  const observations = wh.query('SELECT * FROM core.observations_clean ORDER BY observed_at, report_id');
  const quarantine = wh.query('SELECT * FROM core.quarantine_ledger ORDER BY source_row');
  wh.close();
  const dq = JSON.parse(fs.readFileSync(path.join(dataDir, 'dq_report.json'), 'utf8'));

  const obsByReport = new Map();
  for (const o of observations) {
    if (!obsByReport.has(o.report_id)) obsByReport.set(o.report_id, []);
    obsByReport.get(o.report_id).push(o);
  }
  const costByReport = new Map(cost.unitCost.map((r) => [r.report_id, r]));
  const reportById = new Map(reports.map((r) => [r.report_id, r]));

  let fleet = null; // fleet-wide baselines, computed on first use

  // ---- owner assignments (the only writable state) ----
  const stateFile = path.join(runtimeDir, 'owner-assignments.json');
  let state = { assignments: {}, audit: [] };
  if (fs.existsSync(stateFile)) {
    try {
      state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (err) {
      throw new Error(`${stateFile} is not valid JSON; fix or delete it (${err.message})`);
    }
  }
  const persist = () => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  };

  function summarize(report) {
    const obs = obsByReport.get(report.report_id) ?? [];
    const latest = obs[obs.length - 1];
    const assigned = state.assignments[report.report_id];
    const owner = assigned?.email ?? report.current_owner_email ?? null;
    return {
      report_id: report.report_id,
      report_name: report.report_name,
      owner_email: owner,
      owner_source: assigned ? 'assigned' : owner ? 'observed' : null,
      is_orphaned: owner === null,
      last_known_owner_email: report.last_known_owner_email ?? null,
      orphan_observation_count: report.orphan_observation_count,
      last_refresh_status: report.last_refresh_status,
      last_observed_at: report.last_observed_at,
      latest_load_time_sec: latest ? latest.avg_load_time_sec : null,
      latest_monthly_active_views: latest ? latest.monthly_active_views : null,
      observation_count: report.observation_count,
      latency_breach_count: obs.filter((o) => bool(o.latency_breach)).length,
      failed_refresh_count: obs.filter((o) => isFailure(o.last_refresh_status)).length,
    };
  }

  function costFields(reportId) {
    const c = costByReport.get(reportId);
    if (!c) return null;
    return {
      attributed_credits: c.attributed_credits,
      total_cost_usd: c.total_cost_usd,
      cost_per_view_usd: c.cost_per_view_usd,
      idle_cost_usd: c.idle_cost_usd,
    };
  }

  const store = {
    reportExists: (id) => reportById.has(id),
    // Raw clean readings for one report, oldest first (the evidence builder cuts them off at the alert's own reading).
    observationHistory: (id) => obsByReport.get(id) ?? [],
    fleetBaselines() {
      if (!fleet) {
        const nearestRank = (sorted, p) => (sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]);
        const column = (key) => observations.map((o) => o[key]).sort((a, b) => a - b);
        fleet = {
          readings: observations.length,
          median_load_time_sec: nearestRank(column('avg_load_time_sec'), 0.5),
          p75_query_count_last_30d: nearestRank(column('query_count_last_30d'), 0.75),
          p75_concurrent_user_peak: nearestRank(column('concurrent_user_peak'), 0.75),
          latency_threshold_sec: LATENCY_ALERT_SEC,
          slow_readings_pct: pct(observations.filter((o) => bool(o.latency_breach)).length, observations.length),
        };
      }
      return fleet;
    },
    // Clean observations in time order, with the report name attached (feeds the telemetry simulator).
    observations: () => observations.map((o) => ({ ...o, report_name: reportById.get(o.report_id)?.report_name ?? null })),
    summaries: () => reports.map(summarize),
    summary: (id) => (reportById.has(id) ? summarize(reportById.get(id)) : null),
    costFields,

    detail(id) {
      if (!reportById.has(id)) return null;
      const recent = (obsByReport.get(id) ?? []).slice(-20).reverse().map((o) => ({
        observation_id: o.observation_id,
        observed_at: o.observed_at,
        last_refresh_status: o.last_refresh_status,
        avg_load_time_sec: o.avg_load_time_sec,
        monthly_active_views: o.monthly_active_views,
        concurrent_user_peak: o.concurrent_user_peak,
        owner_email: o.owner_email ?? null,
        latency_breach: bool(o.latency_breach),
      }));
      return { ...summarize(reportById.get(id)), recent_observations: recent };
    },

    // Cost rows for the API, with the owner fields replaced by the effective (possibly reassigned) owner.
    costRows() {
      return cost.unitCost.map((r) => {
        const s = summarize(reportById.get(r.report_id));
        const { is_orphaned, last_known_owner_email, ...rest } = r;
        return { ...rest, owner_email: s.owner_email, is_orphaned: s.is_orphaned, last_known_owner_email: s.last_known_owner_email };
      });
    },

    health(inScope = () => true) {
      const scoped = reports.map(summarize).filter(inScope);
      const byStatus = { SUCCESS: 0, FAILED: 0, TIMED_OUT: 0, UNKNOWN: 0 };
      for (const s of scoped) byStatus[s.last_refresh_status] = (byStatus[s.last_refresh_status] ?? 0) + 1;

      let total = 0, success = 0, failed = 0, timedOut = 0, unknown = 0, breaches = 0, ceiling = 0;
      for (const s of scoped) {
        for (const o of obsByReport.get(s.report_id) ?? []) {
          total++;
          if (o.last_refresh_status === 'SUCCESS') success++;
          else if (o.last_refresh_status === 'FAILED') failed++;
          else if (o.last_refresh_status === 'TIMED_OUT') timedOut++;
          else unknown++;
          if (bool(o.latency_breach)) breaches++;
          if (bool(o.latency_at_ceiling)) ceiling++;
        }
      }
      return {
        reports: { total: scoped.length, orphaned: scoped.filter((s) => s.is_orphaned).length, by_latest_status: byStatus },
        refresh: { observations: total, success, failed, timed_out: timedOut, unknown, failure_pct: pct(failed + timedOut, total) },
        latency: { threshold_sec: LATENCY_ALERT_SEC, breach_observations: breaches, breach_pct: pct(breaches, total), at_ceiling_observations: ceiling },
      };
    },

    // ---- admin-only datasets ----
    quarantine: () => quarantine,
    dqReport: () => dq,
    checks: () => cost.checks,
    variance: () => cost.variance,
    awsMismatch: () => cost.awsMismatch,
    // Every reading's views and hosting cost with the flag the SQL gave it (null = within the band), for the usage-against-cost chart. The fleet rate
    // is the one script 14 uses: total hosting cost over total views, across readings that have views.
    awsUsage() {
      const flags = new Map(cost.awsMismatch.map((r) => [r.observation_id, r.mismatch_type]));
      let aws = 0;
      let views = 0;
      for (const o of observations) {
        if (o.monthly_active_views > 0) {
          aws += o.aws_hosting_cost_usd;
          views += o.monthly_active_views;
        }
      }
      return {
        fleet_aws_per_view: views > 0 ? aws / views : null,
        mismatch_ratio: params.aws_mismatch_ratio,
        readings: observations.map((o) => ({
          observation_id: o.observation_id,
          report_id: o.report_id,
          views: o.monthly_active_views,
          aws_cost_usd: o.aws_hosting_cost_usd,
          mismatch_type: flags.get(o.observation_id) ?? null,
        })),
      };
    },
    costMeta: () => ({ credit_price_usd: params.credit_price_usd, price_is_placeholder: true }),

    // ---- owner assignment ----
    assign(reportId, email, actor) {
      const before = summarize(reportById.get(reportId)).owner_email;
      state.assignments[reportId] = { email, assigned_by: actor, assigned_at: now().toISOString() };
      state.audit.push({ at: now().toISOString(), actor, action: 'ASSIGN', report_id: reportId, from: before, to: email });
      persist();
      return summarize(reportById.get(reportId));
    },
    unassign(reportId, actor) {
      const before = summarize(reportById.get(reportId)).owner_email;
      delete state.assignments[reportId];
      state.audit.push({ at: now().toISOString(), actor, action: 'UNASSIGN', report_id: reportId, from: before, to: summarize(reportById.get(reportId)).owner_email });
      persist();
      return summarize(reportById.get(reportId));
    },
    audit: () => [...state.audit].reverse(),
  };
  return store;
}
