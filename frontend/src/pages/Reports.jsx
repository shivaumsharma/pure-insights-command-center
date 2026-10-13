import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { can } from '../auth/permissions.js';
import { Badge, Button, Card, DataTable, EmptyState, ErrorBox, Field, OwnerCell, PageHeader, Pagination, Skeleton, StatusBadge } from '../components/ui.jsx';
import { fmtInt, fmtSec, fmtUsd, STATUS_LABEL } from '../lib/format.js';
import { useQuery } from '../lib/useQuery.js';

const PAGE_SIZE = 25;
const SORTS = [
  ['report_id', 'Report ID'],
  ['latency', 'Slowest latest load'],
  ['failures', 'Most failed refreshes'],
  ['breaches', 'Most slow readings'],
  ['cost', 'Highest cost'],
];

export default function Reports() {
  const { api, user } = useAuth();
  const [params, setParams] = useSearchParams();
  const showCosts = can(user, 'costs');
  const allowedSorts = SORTS.filter(([k]) => k !== 'cost' || showCosts);

  const q = params.get('q') ?? '';
  const status = Object.keys(STATUS_LABEL).includes(params.get('status')) ? params.get('status') : '';
  const orphaned = ['true', 'false'].includes(params.get('orphaned')) ? params.get('orphaned') : '';
  const sort = allowedSorts.some(([k]) => k === params.get('sort')) ? params.get('sort') : 'report_id';
  const offset = Math.max(0, Number.parseInt(params.get('offset') ?? '0', 10) || 0);
  const [search, setSearch] = useState(q);

  useEffect(() => { document.title = 'Reports · Pure Insights'; }, []);
  useEffect(() => setSearch(q), [q]);

  const result = useQuery(
    () => api.get('/api/reports', { q, status, orphaned, sort, limit: PAGE_SIZE, offset }),
    [api, q, status, orphaned, sort, offset],
  );

  function update(changes) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) {
      if (v === '' || v === undefined || v === null) next.delete(k);
      else next.set(k, String(v));
    }
    if (!('offset' in changes)) next.delete('offset');
    setParams(next, { replace: true });
  }

  const filtered = Boolean(q || status || orphaned);
  const rows = result.data?.data ?? [];
  const columns = [
    {
      key: 'report', header: 'Report',
      render: (r) => (<><Link to={`/reports/${r.report_id}`}>{r.report_id}</Link><div className="muted small">{r.report_name}</div></>),
    },
    { key: 'owner', header: 'Owner', render: (r) => <OwnerCell report={r} /> },
    { key: 'status', header: 'Latest refresh', render: (r) => <StatusBadge status={r.last_refresh_status} /> },
    {
      key: 'load', header: 'Latest load', align: 'right',
      render: (r) => (<>{fmtSec(r.latest_load_time_sec)} {r.latest_load_time_sec > 15 && <Badge tone="warning">Slow</Badge>}</>),
    },
    { key: 'failures', header: 'Failed refreshes', align: 'right', render: (r) => fmtInt(r.failed_refresh_count) },
    { key: 'breaches', header: 'Slow readings', align: 'right', render: (r) => fmtInt(r.latency_breach_count) },
    ...(showCosts ? [{ key: 'cpv', header: 'Cost per view', align: 'right', render: (r) => fmtUsd(r.cost?.cost_per_view_usd) }] : []),
  ];

  return (
    <>
      <PageHeader
        title="Reports"
        description={user.role === 'owner' ? 'The reports you own.' : 'Every report with its owner, latest refresh and how often it was slow or failed.'}
      />

      <Card>
        <form className="filters" role="search" aria-label="Filter reports" onSubmit={(e) => { e.preventDefault(); update({ q: search.trim() }); }}>
          <Field id="search" label="Search by ID or name">
            <input id="search" type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} />
          </Field>
          <Field id="status" label="Latest refresh">
            <select id="status" value={status} onChange={(e) => update({ status: e.target.value })}>
              <option value="">Any</option>
              {Object.entries(STATUS_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
          <Field id="orphaned" label="Ownership">
            <select id="orphaned" value={orphaned} onChange={(e) => update({ orphaned: e.target.value })}>
              <option value="">Any</option>
              <option value="true">No owner</option>
              <option value="false">Has an owner</option>
            </select>
          </Field>
          <Field id="sort" label="Sort by">
            <select id="sort" value={sort} onChange={(e) => update({ sort: e.target.value === 'report_id' ? '' : e.target.value })}>
              {allowedSorts.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
          <Button type="submit">Search</Button>
        </form>
      </Card>

      <ErrorBox error={result.error} onRetry={result.reload} />
      {!result.data && !result.error && <Skeleton rows={6} />}
      {result.data && rows.length === 0 && (
        <EmptyState
          title={filtered ? 'No reports match these filters.' : 'There are no reports to show yet.'}
          action={filtered ? <Button variant="secondary" onClick={() => setParams({}, { replace: true })}>Clear filters</Button> : undefined}
        >
          {filtered ? 'Try a different search, or clear the filters.' : 'Reports appear here once data has been loaded.'}
        </EmptyState>
      )}
      {result.data && rows.length > 0 && (
        <>
          <DataTable caption="Reports" rows={rows} rowKey={(r) => r.report_id} columns={columns} />
          <Pagination total={result.data.page.total} limit={PAGE_SIZE} offset={offset} noun="reports" onChange={(o) => update({ offset: o || '' })} />
        </>
      )}
    </>
  );
}
