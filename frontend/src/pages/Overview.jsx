import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { can } from '../auth/permissions.js';
import { AlertRow } from '../components/AlertRow.jsx';
import { DataDisclosure } from '../components/charts/DataDisclosure.jsx';
import { Donut } from '../components/charts/Donut.jsx';
import { FleetMap } from '../components/charts/FleetMap.jsx';
import { BarList, StackBars } from '../components/charts/StackBars.jsx';
import { Card, DataTable, EmptyState, ErrorBox, Kpi, PageHeader, PriceBanner, Skeleton } from '../components/ui.jsx';
import { compact } from '../lib/chartMath.js';
import { fmtInt, fmtPct, fmtUsd, SEVERITY_ORDER } from '../lib/format.js';
import { alertFlow, spendBreakdown, topBy } from '../lib/summaries.js';
import { useQuery } from '../lib/useQuery.js';
import { useLive } from '../live/LiveContext.jsx';

const SEVERITY_TONE = { critical: 'danger', high: 'brand', medium: 'warning', low: 'info' };
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const usdShort = (v) => `$${compact(v)}`; // $1.2M: a ring is too small for a full dollar figure

function Loading({ query, rows = 3 }) {
  return (
    <>
      <ErrorBox error={query.error} onRetry={query.reload} />
      {!query.data && !query.error && <Skeleton rows={rows} />}
    </>
  );
}

// Admin only: how many breaching readings became alerts and how many were held back as repeats (counters since the server started).
function AlertNoise({ summary }) {
  const f = alertFlow(summary);
  const rows = [
    { key: 'breaches', label: 'Readings that breached', valueText: fmtInt(f.breaches), segments: [{ value: f.sent, tone: 'brand' }, { value: f.held, tone: 'muted' }] },
    { key: 'stages', label: 'Alerts sent', valueText: fmtInt(f.sent), segments: [{ value: f.stages.TRIGGERED, tone: 'info' }, { value: f.stages.ESCALATED, tone: 'danger' }, { value: f.stages.REPEATED, tone: 'warning' }] },
    { key: 'resolved', label: 'Resolved', valueText: fmtInt(f.resolved), segments: [{ value: f.resolved, tone: 'success' }] },
  ];
  return (
    <>
      <StackBars
        label="How breaching readings became alerts"
        rows={rows}
        max={f.breaches}
        legend={[
          { key: 'sent', tone: 'brand', label: 'Became an alert' }, { key: 'held', tone: 'muted', label: 'Held back as a repeat' },
          { key: 'new', tone: 'info', label: 'New' }, { key: 'worse', tone: 'danger', label: 'Worse' }, { key: 'still', tone: 'warning', label: 'Still open' }, { key: 'ok', tone: 'success', label: 'Resolved' },
        ]}
      />
      <p className="small section-note">
        {f.breaches > 0
          ? <><strong>{f.heldPct}%</strong> of breaching readings were held back as repeats instead of announcing the same problem again. Counted since the server started, over {fmtInt(f.readings)} readings.</>
          : 'No readings have breached yet.'}
      </p>
    </>
  );
}

function Spend({ rows, meta }) {
  const s = spendBreakdown(rows);
  const top = topBy(rows, 'total_cost_usd', 8);
  return (
    <>
      <Card title="Biggest spenders" subtitle="Attributed Snowflake credits plus hosting. The orange part is spend while nobody was viewing." actions={<Link to="/costs">Cost details</Link>}>
        <PriceBanner meta={meta} />
        {top.length === 0 ? <EmptyState title="No cost data to show." /> : (
          <>
            <StackBars
              label="The eight most expensive reports"
              rows={top.map((r) => ({
                key: r.report_id, label: r.report_id, to: `/reports/${r.report_id}`, valueText: fmtUsd(r.total_cost_usd),
                segments: [{ value: r.total_cost_usd - r.idle_cost_usd, tone: 'brand' }, { value: r.idle_cost_usd, tone: 'warning' }],
              }))}
              legend={[{ key: 'used', tone: 'brand', label: 'While in use' }, { key: 'idle', tone: 'warning', label: 'Idle (no views)' }]}
            />
            <DataDisclosure>
              <DataTable
                caption="Most expensive reports"
                rowKey={(r) => r.report_id}
                rows={top}
                columns={[
                  { key: 'report', header: 'Report', render: (r) => <Link to={`/reports/${r.report_id}`}>{r.report_id}</Link> },
                  { key: 'total', header: 'Total cost', align: 'right', render: (r) => fmtUsd(r.total_cost_usd) },
                  { key: 'view', header: 'Cost per view', align: 'right', render: (r) => fmtUsd(r.cost_per_view_usd) },
                  { key: 'idle', header: 'Idle spend', align: 'right', render: (r) => fmtUsd(r.idle_cost_usd) },
                ]}
              />
            </DataDisclosure>
          </>
        )}
      </Card>

      {top.length > 0 && (
        <div className="grid-2">
          <Card title="What the money pays for" subtitle="Snowflake credits against hosting, across the reports you can see.">
            <Donut
              ariaLabel={`Snowflake credits ${fmtUsd(s.credits)}, hosting ${fmtUsd(s.hosting)}`}
              centerValue={usdShort(s.total)} centerLabel="in total" formatValue={usdShort}
              segments={[{ key: 'credits', label: 'Snowflake credits', value: s.credits, tone: 'brand' }, { key: 'hosting', label: 'Hosting', value: s.hosting, tone: 'dark' }]}
            />
          </Card>
          <Card title="Spend nobody owns" subtitle="Money going to reports with no current owner.">
            <Donut
              ariaLabel={`Owned ${fmtUsd(s.owned)}, with no owner ${fmtUsd(s.unowned)}`}
              centerValue={`${s.unownedPct}%`} centerLabel="has no owner" formatValue={usdShort}
              segments={[{ key: 'owned', label: 'Has an owner', value: s.owned, tone: 'dark' }, { key: 'unowned', label: 'No owner', value: s.unowned, tone: 'brand' }]}
            />
          </Card>
        </div>
      )}
    </>
  );
}

export default function Overview() {
  const { api, user } = useAuth();
  const live = useLive();
  useEffect(() => { document.title = 'Overview · Pure Insights'; }, []);

  const isAdmin = user.role === 'admin';
  const health = useQuery(() => api.get('/api/health'), [api]);
  const active = useQuery(() => api.get('/api/alerts/active', { limit: 1 }), [api, live.version]); // counts come from meta, not rows
  const fleet = useQuery(() => api.get('/api/reports', { limit: 200 }), [api]); // every report on one page: the fleet map needs them all
  const summary = useQuery(() => api.get('/api/alerts/summary'), [api], { enabled: isAdmin });
  const costs = useQuery(() => api.get('/api/costs/reports', { limit: 200 }), [api], { enabled: can(user, 'costs') });

  const h = health.data;
  const owned = h?.scope === 'owned';
  const bySeverity = active.data?.meta?.by_severity ?? {};
  const openTotal = active.data?.page.total ?? 0;
  const status = h?.reports.by_latest_status ?? {};

  return (
    <>
      <PageHeader
        title="Overview"
        description={owned ? 'Health of the reports you own.' : 'Health of every report, what is alerting right now, and where the money goes.'}
      />

      <ErrorBox error={health.error} onRetry={health.reload} />
      {!h && !health.error && <Skeleton rows={2} />}
      {h && (
        <>
          <div className="grid-kpi">
            <Kpi label={owned ? 'Your reports' : 'Reports'} value={fmtInt(h.reports.total)} icon="file" />
            <Kpi label="Without an owner" value={fmtInt(h.reports.orphaned)} tone={h.reports.orphaned > 0 ? 'warning' : undefined} icon="userOff"
              meter={h.reports.total > 0 ? (100 * h.reports.orphaned) / h.reports.total : 0}
              to={can(user, 'orphans') ? '/orphans' : '/reports?orphaned=true'} hint="Nobody is responsible for these" />
            <Kpi label="Refreshes failing" value={fmtPct(h.refresh.failure_pct)} tone={h.refresh.failure_pct > 10 ? 'danger' : undefined} icon="refresh" meter={h.refresh.failure_pct}
              hint={`${fmtInt(h.refresh.failed + h.refresh.timed_out)} of ${fmtInt(h.refresh.observations)} readings failed or timed out`} />
            <Kpi label={`Loads over ${h.latency.threshold_sec} s`} value={fmtPct(h.latency.breach_pct)} tone={h.latency.breach_pct > 25 ? 'warning' : undefined} icon="bolt" meter={h.latency.breach_pct}
              hint={`${fmtInt(h.latency.breach_observations)} slow readings`} />
          </div>

          <div className="grid-2">
            <Card title="Latest refresh status" subtitle="Where each report stands on its most recent reading.">
              <Donut
                ariaLabel={`Healthy ${status.SUCCESS ?? 0}, failed ${status.FAILED ?? 0}, timed out ${status.TIMED_OUT ?? 0}, unknown ${status.UNKNOWN ?? 0}`}
                centerValue={fmtInt(h.reports.total)} centerLabel="reports"
                segments={[
                  { key: 'ok', label: 'Healthy', value: status.SUCCESS ?? 0, tone: 'success' },
                  { key: 'failed', label: 'Failed', value: status.FAILED ?? 0, tone: 'danger' },
                  { key: 'timeout', label: 'Timed out', value: status.TIMED_OUT ?? 0, tone: 'warning' },
                  { key: 'unknown', label: 'Unknown', value: status.UNKNOWN ?? 0, tone: 'muted' },
                ]}
              />
            </Card>

            <Card title="Open alerts" subtitle="Conditions that are true right now." actions={<Link to="/alerts">All alerts</Link>}>
              <ErrorBox error={active.error} onRetry={active.reload} />
              {!active.data && !active.error && <Skeleton rows={2} />}
              {active.data && (openTotal === 0
                ? <EmptyState icon="check" title="Nothing is alerting.">Alerts appear here as soon as a report is slow or its refresh fails.</EmptyState>
                : (
                  <>
                    <div role="group" aria-label={`${openTotal} open alerts by severity`}>
                      <BarList
                        label="Open alerts by severity"
                        rows={SEVERITY_ORDER.map((s) => ({ key: s, label: cap(s), value: bySeverity[s] ?? 0, tone: SEVERITY_TONE[s], valueText: fmtInt(bySeverity[s] ?? 0) }))}
                      />
                    </div>
                    <p className="muted small section-note">{openTotal} open. Most reports in this data set are almost always over the threshold, so filter by severity on the Alerts page.</p>
                  </>
                ))}
            </Card>
          </div>
        </>
      )}

      <Card title="Fleet map" subtitle="One tile per report: its latest refresh, and a dot when its latest load time is over the limit. Open one for its history.">
        <Loading query={fleet} rows={3} />
        {fleet.data && fleet.data.data.length === 0 && <EmptyState title="No reports to show." />}
        {fleet.data && fleet.data.data.length > 0 && <FleetMap reports={fleet.data.data} threshold={h?.latency.threshold_sec} />}
      </Card>

      <div className="grid-2">
        {isAdmin && (
          <Card title="Alert noise" subtitle="How many breaching readings turned into alerts.">
            <Loading query={summary} rows={2} />
            {summary.data && <AlertNoise summary={summary.data.data} />}
          </Card>
        )}
        <Card title="Live feed" subtitle="Newest alerts first, as they arrive.">
          {live.events.length === 0 ? (
            <EmptyState title="Waiting for the first alert…">The feed is {live.status === 'live' ? 'connected and quiet' : 'connecting'}.</EmptyState>
          ) : (
            <ul className="feed" aria-label="Latest alerts">
              {live.events.slice(0, 6).map((a) => <AlertRow key={a.event_id} alert={a} />)}
            </ul>
          )}
        </Card>
      </div>

      {can(user, 'costs') && (
        <>
          <Loading query={costs} rows={3} />
          {costs.data && <Spend rows={costs.data.data} meta={costs.data.meta} />}
        </>
      )}
    </>
  );
}
