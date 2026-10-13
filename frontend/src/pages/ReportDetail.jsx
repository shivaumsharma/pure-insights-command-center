import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { can } from '../auth/permissions.js';
import { AlertRow } from '../components/AlertRow.jsx';
import { AssignOwnerForm } from '../components/AssignOwnerForm.jsx';
import { LineChart } from '../components/charts/LineChart.jsx';
import { Segmented } from '../components/charts/Segmented.jsx';
import { StackBars } from '../components/charts/StackBars.jsx';
import { Badge, Button, Card, DataTable, EmptyState, ErrorBox, Kpi, OwnerCell, PageHeader, PriceBanner, Skeleton, StatusBadge } from '../components/ui.jsx';
import { fmtCredits, fmtEventTime, fmtInt, fmtSec, fmtUsd, STATUS_LABEL } from '../lib/format.js';
import { useQuery } from '../lib/useQuery.js';

const REFRESH_KIND = { SUCCESS: 'ok', FAILED: 'bad', TIMED_OUT: 'bad' };
const range = (values) => `highest ${Math.max(...values)}, lowest ${Math.min(...values)}`;

export default function ReportDetail() {
  const { id } = useParams();
  const { api, user } = useAuth();
  const [removeError, setRemoveError] = useState(null);
  const [span, setSpan] = useState('all'); // how many readings the charts show
  const report = useQuery(() => api.get(`/api/reports/${encodeURIComponent(id)}`), [api, id]);
  const alerts = useQuery(() => api.get('/api/alerts', { report_id: id, limit: 8 }), [api, id], { enabled: report.data !== null });

  useEffect(() => { document.title = `${id} · Pure Insights`; }, [id]);

  if (report.error?.status === 404) {
    return (
      <>
        <PageHeader title="Report not found" />
        <EmptyState title={`We could not find ${id}.`} action={<Link className="btn btn-primary" to="/reports">Back to reports</Link>}>
          It may not exist, or it may belong to someone else.
        </EmptyState>
      </>
    );
  }
  if (report.error) return <><PageHeader title={id} /><ErrorBox error={report.error} onRetry={report.reload} /></>;
  if (!report.data) return <><PageHeader title={id} /><Skeleton rows={4} /></>;

  const r = report.data.data;
  const meta = report.data.meta;
  const everyReading = [...r.recent_observations].reverse(); // oldest first for the charts
  const observations = span === 'recent' ? everyReading.slice(-10) : everyReading;
  const at = (o) => fmtEventTime(o.observed_at);
  const loadPoints = observations.map((o) => ({
    key: o.observation_id, label: at(o), value: o.avg_load_time_sec, kind: REFRESH_KIND[o.last_refresh_status] ?? 'unknown',
    note: o.last_refresh_status === 'SUCCESS' ? undefined : `refresh ${(STATUS_LABEL[o.last_refresh_status] ?? o.last_refresh_status).toLowerCase()}`,
  }));
  const viewPoints = observations.map((o) => ({ key: o.observation_id, label: at(o), value: o.monthly_active_views }));
  const peakPoints = observations.map((o) => ({ key: o.observation_id, label: at(o), value: o.concurrent_user_peak }));

  async function removeAssignment() {
    setRemoveError(null);
    try {
      await api.del(`/api/reports/${encodeURIComponent(id)}/owner`);
      report.reload();
    } catch (err) {
      setRemoveError(err.message);
    }
  }

  return (
    <>
      <PageHeader
        title={r.report_id}
        description={r.report_name}
        actions={<Link className="btn btn-secondary" to="/reports">All reports</Link>}
      />

      <div className="grid-kpi">
        <Kpi label="Latest refresh" value={<StatusBadge status={r.last_refresh_status} />} hint={fmtEventTime(r.last_observed_at)} />
        <Kpi label="Latest load time" value={fmtSec(r.latest_load_time_sec)} tone={r.latest_load_time_sec > 15 ? 'warning' : undefined} hint="Alert threshold is 15 s" />
        <Kpi label="Failed refreshes" value={fmtInt(r.failed_refresh_count)} hint={`of ${fmtInt(r.observation_count)} readings`} />
        <Kpi label="Slow readings" value={fmtInt(r.latency_breach_count)} hint="Over 15 s" />
      </div>

      <div className="grid-2">
        <Card title="Owner">
          <p><OwnerCell report={r} /> {r.owner_source === 'assigned' && <Badge tone="info">Assigned by an admin</Badge>}</p>
          {r.is_orphaned && r.last_known_owner_email && <p className="muted small">Last known owner: {r.last_known_owner_email}</p>}
          {r.orphan_observation_count > 0 && <p className="muted small">{r.orphan_observation_count} readings had no owner on record.</p>}
          {can(user, 'assignOwner') && (
            <div style={{ marginTop: 'var(--pi-space-4)' }}>
              <AssignOwnerForm report={r} onAssigned={() => report.reload()} />
              {r.owner_source === 'assigned' && (
                <p style={{ marginTop: 'var(--pi-space-3)' }}>
                  <Button variant="secondary" onClick={removeAssignment}>Remove assignment</Button>
                </p>
              )}
              {removeError && <p className="field-error" role="alert">{removeError}</p>}
            </div>
          )}
        </Card>

        {r.cost ? (
          <Card title="Cost" subtitle="Snowflake credits attributed to this report, plus hosting.">
            <PriceBanner meta={meta} />
            <StackBars
              label="How this report's spend splits between use and idle time"
              rows={[{ key: 'split', label: 'Total cost', valueText: fmtUsd(r.cost.total_cost_usd), segments: [{ value: r.cost.total_cost_usd - r.cost.idle_cost_usd, tone: 'brand' }, { value: r.cost.idle_cost_usd, tone: 'warning' }] }]}
              legend={[{ key: 'used', tone: 'brand', label: 'While in use' }, { key: 'idle', tone: 'warning', label: 'Idle (no views)' }]}
            />
            <dl className="small" style={{ margin: 'var(--pi-space-3) 0 0' }}>
              <div><dt className="muted">Attributed credits</dt><dd style={{ margin: 0 }}>{fmtCredits(r.cost.attributed_credits)}</dd></div>
              <div><dt className="muted">Total cost</dt><dd style={{ margin: 0 }}>{fmtUsd(r.cost.total_cost_usd)}</dd></div>
              <div><dt className="muted">Cost per view</dt><dd style={{ margin: 0 }}>{fmtUsd(r.cost.cost_per_view_usd)}</dd></div>
              <div><dt className="muted">Idle spend (no views)</dt><dd style={{ margin: 0 }}>{fmtUsd(r.cost.idle_cost_usd)}</dd></div>
            </dl>
          </Card>
        ) : (
          <Card title="Cost"><p className="muted">Cost details are not available for your role.</p></Card>
        )}
      </div>

      <Card
        title="Load time"
        actions={everyReading.length > 10 && (
          <Segmented
            label="Readings shown" value={span} onChange={setSpan}
            options={[{ value: 'recent', label: 'Last 10' }, { value: 'all', label: `All ${everyReading.length}` }]}
          />
        )}
        subtitle="Each reading, oldest to newest. The dashed line is the 15 s alert threshold; a diamond marks a refresh that failed or timed out.">
        <LineChart
          points={loadPoints} threshold={15} thresholdLabel="15 s limit" unit=" s" formatValue={fmtSec}
          ariaLabel={`Load time over the last ${observations.length} readings; highest ${Math.max(...observations.map((o) => o.avg_load_time_sec))} seconds; alert threshold 15 seconds`}
        />
      </Card>

      <div className="grid-2">
        <Card title="Views" subtitle="Monthly active views at each reading.">
          <LineChart points={viewPoints} tone="dark" formatValue={fmtInt} ariaLabel={`Monthly active views over the last ${observations.length} readings; ${range(viewPoints.map((p) => p.value))}`} height={160} />
        </Card>
        <Card title="Peak concurrent users" subtitle="The busiest moment at each reading.">
          <LineChart points={peakPoints} tone="dark" formatValue={fmtInt} ariaLabel={`Peak concurrent users over the last ${observations.length} readings; ${range(peakPoints.map((p) => p.value))}`} height={160} />
        </Card>
      </div>

      <Card title="Recent alerts">
        <ErrorBox error={alerts.error} onRetry={alerts.reload} />
        {!alerts.data && !alerts.error && <Skeleton rows={2} />}
        {alerts.data && alerts.data.data.length === 0 && <EmptyState title="No alerts for this report yet." />}
        {alerts.data && alerts.data.data.length > 0 && <ul className="feed" aria-label="Recent alerts for this report">{alerts.data.data.map((a) => <AlertRow key={a.event_id} alert={a} />)}</ul>}
      </Card>

      <Card title="Recent readings">
        <DataTable
          caption={`Recent readings for ${r.report_id}`}
          rows={r.recent_observations}
          rowKey={(o) => o.observation_id}
          columns={[
            { key: 'time', header: 'When', render: (o) => fmtEventTime(o.observed_at) },
            { key: 'status', header: 'Refresh', render: (o) => <StatusBadge status={o.last_refresh_status} /> },
            { key: 'load', header: 'Load time', align: 'right', render: (o) => <>{fmtSec(o.avg_load_time_sec)} {o.latency_breach && <Badge tone="warning">Slow</Badge>}</> },
            { key: 'views', header: 'Views', align: 'right', render: (o) => fmtInt(o.monthly_active_views) },
            { key: 'peak', header: 'Peak concurrent', align: 'right', render: (o) => fmtInt(o.concurrent_user_peak) },
            { key: 'owner', header: 'Owner on record', render: (o) => (o.owner_email ? <span className="mono small">{o.owner_email}</span> : <span className="muted">None</span>) },
          ]}
        />
      </Card>
    </>
  );
}
