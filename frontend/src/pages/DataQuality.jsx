import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { BarList, StackBars } from '../components/charts/StackBars.jsx';
import { Card, DataTable, EmptyState, ErrorBox, Kpi, PageHeader, Pagination, Skeleton } from '../components/ui.jsx';
import { fmtInt } from '../lib/format.js';
import { useQuery } from '../lib/useQuery.js';

const REASON_LABEL = {
  NEGATIVE_CREDITS: 'Negative Snowflake credits',
  NON_NUMERIC: 'A number was not a number',
  NON_INTEGER: 'A count was fractional',
  NEGATIVE_VALUE: 'A value was negative',
  MISSING_REPORT_ID: 'No report ID',
  DUPLICATE_ROW: 'Exact duplicate of an earlier row',
  MALFORMED_ROW: 'Wrong number of fields',
};
const FLAG_ROWS = [
  ['orphan_observations', 'Readings with no owner', 'Kept: the report still costs money'],
  ['status_unknown', 'Refresh status unknown', 'Kept: unknown is not a failure, so it raises no alert'],
  ['zero_views', 'Readings with zero views', 'Kept: spend with nobody using it'],
  ['concurrency_exceeds_views', 'Peak users above total views', 'Kept: implausible, but we cannot tell which number is wrong'],
];
const PAGE_SIZE = 25;

// 242 readings have no owner, but that is rows, not reports: say so, and give the report counts beside it (the Overview shows 13).
const ownerHint = (d, why) => (d.reports
  ? `These are rows, not reports: ${d.reports.with_any_orphan_observation} reports have at least one, and ${d.reports.currently_orphaned} have no owner right now. ${why}`
  : why);

export default function DataQuality() {
  const { api } = useAuth();
  const [offset, setOffset] = useState(0);
  useEffect(() => { document.title = 'Data quality · Pure Insights'; }, []);

  const dq = useQuery(() => api.get('/api/dq-report'), [api]);
  const ledger = useQuery(() => api.get('/api/quarantine', { limit: PAGE_SIZE, offset }), [api, offset]);
  const d = dq.data?.data;

  return (
    <>
      <PageHeader title="Data quality" description="What was wrong with the source data and what was done about it. Nothing is deleted: every excluded row is listed here with its reason." />
      <ErrorBox error={dq.error} onRetry={dq.reload} />
      {!d && !dq.error && <Skeleton rows={3} />}
      {d && (
        <>
          <div className="grid-kpi">
            <Kpi label="Rows received" value={fmtInt(d.rows.in)} icon="layers" />
            <Kpi label="Used" value={fmtInt(d.rows.clean)} icon="check" tone="success" meter={d.rows.in > 0 ? (100 * d.rows.clean) / d.rows.in : 0} />
            <Kpi label="Set aside" value={fmtInt(d.rows.quarantined)} tone={d.rows.quarantined > 0 ? 'warning' : undefined} icon="shield" hint="Kept in the ledger below" />
            <Kpi label="Every row accounted for" value={d.rows.conserved ? 'Yes' : 'No'} tone={d.rows.conserved ? 'success' : 'danger'} hint="Used plus set aside equals received" />
          </div>

          <Card title="Where the rows went" subtitle="Every row received is either used or set aside. None are deleted.">
            <StackBars
              label="Rows used and rows set aside"
              max={d.rows.in}
              rows={[{ key: 'rows', label: 'Rows received', valueText: fmtInt(d.rows.in), segments: [{ value: d.rows.clean, tone: 'success' }, { value: d.rows.quarantined, tone: 'warning' }] }]}
              legend={[{ key: 'used', tone: 'success', label: 'Used', value: fmtInt(d.rows.clean) }, { key: 'aside', tone: 'warning', label: 'Set aside', value: fmtInt(d.rows.quarantined) }]}
            />
          </Card>

          <div className="grid-2">
            <Card title="Set aside" subtitle="Rows whose numbers cannot be trusted.">
              <BarList
                label="Rows set aside, by reason"
                rows={Object.entries(d.quarantine_by_reason).map(([k, n]) => ({ key: k, label: REASON_LABEL[k] ?? k, value: n, tone: 'warning', valueText: fmtInt(n) }))}
              />
            </Card>
            <Card title="Kept but flagged" subtitle="Odd, but not untrustworthy.">
              <BarList
                label="Rows kept but flagged"
                rows={FLAG_ROWS.map(([k, label, why]) => ({ key: k, label, hint: k === 'orphan_observations' ? ownerHint(d, why) : why, value: d.flags_on_clean_rows[k], tone: 'info', valueText: fmtInt(d.flags_on_clean_rows[k]) }))}
              />
            </Card>
          </div>
        </>
      )}

      <Card title="Ledger of set-aside rows" subtitle="The original line is kept so every exclusion can be checked.">
        <ErrorBox error={ledger.error} onRetry={ledger.reload} />
        {!ledger.data && !ledger.error && <Skeleton rows={4} />}
        {ledger.data && ledger.data.data.length === 0 && <EmptyState title="Nothing has been set aside." />}
        {ledger.data && ledger.data.data.length > 0 && (
          <>
            <DataTable
              caption="Ledger of set-aside rows"
              rows={ledger.data.data}
              rowKey={(r) => r.source_row}
              columns={[
                { key: 'row', header: 'Source line', align: 'right', render: (r) => r.source_row },
                { key: 'r', header: 'Report', render: (r) => (r.report_id ? <Link to={`/reports/${r.report_id}`}>{r.report_id}</Link> : '—') },
                { key: 'why', header: 'Reason', render: (r) => r.reason_codes.split('|').map((c) => REASON_LABEL[c] ?? c).join(', ') },
                { key: 'detail', header: 'Detail', mono: true, render: (r) => r.reason_detail },
              ]}
            />
            <Pagination total={ledger.data.page.total} limit={PAGE_SIZE} offset={offset} noun="rows" onChange={setOffset} />
          </>
        )}
      </Card>
    </>
  );
}
