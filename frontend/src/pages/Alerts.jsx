import { useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { AlertRow } from '../components/AlertRow.jsx';
import { StackBars } from '../components/charts/StackBars.jsx';
import { Button, Card, EmptyState, ErrorBox, Field, PageHeader, Pagination, SeverityBadge, Skeleton, alertKind } from '../components/ui.jsx';
import { ALERT_TYPE_LABEL, fmtEventTime, fmtInt, LIFECYCLE_LABEL, plural, SEVERITY_ORDER } from '../lib/format.js';
import { useQuery } from '../lib/useQuery.js';
import { useLive } from '../live/LiveContext.jsx';

const PAGE_SIZE = 25;
const SEVERITY_TONE = { critical: 'danger', high: 'brand', medium: 'warning', low: 'info' };
const pick = (value, allowed) => (allowed.includes(value) ? value : '');

export default function Alerts() {
  const { api } = useAuth();
  const live = useLive();
  const [params, setParams] = useSearchParams();
  useEffect(() => { document.title = 'Alerts · Pure Insights'; }, []);

  const severity = pick(params.get('severity'), SEVERITY_ORDER);
  const alertType = pick(params.get('alert_type'), Object.keys(ALERT_TYPE_LABEL));
  const lifecycle = pick(params.get('lifecycle'), Object.keys(LIFECYCLE_LABEL));
  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0);

  const active = useQuery(() => api.get('/api/alerts/active', { limit: 10, severity: undefined }), [api, live.version]);
  const history = useQuery(
    () => api.get('/api/alerts', { severity, alert_type: alertType, lifecycle, limit: PAGE_SIZE, offset }),
    [api, severity, alertType, lifecycle, offset, live.version],
  );

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === '' || v === undefined) next.delete(k);
      else next.set(k, String(v));
    }
    if (!('offset' in changes)) next.delete('offset');
    setParams(next, { replace: true });
  }

  const filtered = Boolean(severity || alertType || lifecycle);
  const rows = history.data?.data ?? [];

  return (
    <>
      <PageHeader title="Alerts" description="What is wrong now, and the history of what has been raised. Repeat readings are held back so the same problem is not announced over and over." />

      {live.gaps > 0 && (
        <p className="notice" role="status">The connection dropped and some alerts were missed. The lists below were refreshed to catch up.</p>
      )}

      <Card title="Open now" subtitle="Worst first. Showing up to 10." actions={<span className="muted small">{active.data?.page.total ?? 0} open in total</span>}>
        <ErrorBox error={active.error} onRetry={active.reload} />
        {!active.data && !active.error && <Skeleton rows={3} />}
        {active.data && active.data.data.length === 0 && <EmptyState icon="check" title="Nothing is alerting right now." />}
        {active.data && active.data.data.length > 0 && (
          <StackBars
            label="Open alerts by severity"
            max={active.data.page.total}
            rows={[{ key: 'sev', label: 'All open', valueText: fmtInt(active.data.page.total), segments: SEVERITY_ORDER.map((s) => ({ value: active.data.meta?.by_severity?.[s] ?? 0, tone: SEVERITY_TONE[s] })) }]}
            legend={SEVERITY_ORDER.map((s) => ({ key: s, tone: SEVERITY_TONE[s], label: s[0].toUpperCase() + s.slice(1), value: fmtInt(active.data.meta?.by_severity?.[s] ?? 0) }))}
          />
        )}
        {active.data && active.data.data.length > 0 && (
          <ul className="feed" aria-label="Open alerts" style={{ marginTop: 'var(--pi-space-3)' }}>
            {active.data.data.map((a) => (
              <li key={`${a.report_id}-${a.alert_type}`} data-sev={a.severity}>
                <SeverityBadge severity={a.severity} />
                <div>
                  <p><Link to={`/reports/${a.report_id}`}>{a.report_id}</Link> <span className="muted">· {alertKind(a)}</span></p>
                </div>
                <p className="feed-meta">Since {fmtEventTime(a.since)}{a.suppressed_since_last > 0 && ` · ${plural(a.suppressed_since_last, 'repeat reading')} held back`}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="History" subtitle="Newest first.">
        <form className="filters" aria-label="Filter alerts" onSubmit={(e) => e.preventDefault()}>
          <Field id="severity" label="Severity">
            <select id="severity" value={severity} onChange={(e) => update({ severity: e.target.value })}>
              <option value="">Any</option>
              {SEVERITY_ORDER.map((s) => <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>)}
            </select>
          </Field>
          <Field id="alert_type" label="Kind">
            <select id="alert_type" value={alertType} onChange={(e) => update({ alert_type: e.target.value })}>
              <option value="">Any</option>
              {Object.entries(ALERT_TYPE_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
          <Field id="lifecycle" label="Stage">
            <select id="lifecycle" value={lifecycle} onChange={(e) => update({ lifecycle: e.target.value })}>
              <option value="">Any</option>
              {Object.entries(LIFECYCLE_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
        </form>

        <div style={{ marginTop: 'var(--pi-space-4)' }}>
          <ErrorBox error={history.error} onRetry={history.reload} />
          {!history.data && !history.error && <Skeleton rows={5} />}
          {history.data && rows.length === 0 && (
            <EmptyState
              title={filtered ? 'No alerts match these filters.' : 'No alerts have been raised yet.'}
              action={filtered ? <Button variant="secondary" onClick={() => setParams({}, { replace: true })}>Clear filters</Button> : undefined}
            />
          )}
          {rows.length > 0 && <ul className="feed" aria-label="Alert history">{rows.map((a) => <AlertRow key={a.event_id} alert={a} />)}</ul>}
          {history.data && <Pagination total={history.data.page.total} limit={PAGE_SIZE} offset={offset} noun="alerts" onChange={(o) => update({ offset: o || '' })} />}
        </div>
      </Card>
    </>
  );
}
