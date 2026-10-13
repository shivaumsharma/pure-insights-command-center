import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { AssignOwnerForm } from '../components/AssignOwnerForm.jsx';
import { Button, Card, DataTable, EmptyState, ErrorBox, Kpi, Money, PageHeader, Pagination, PriceBanner, Skeleton } from '../components/ui.jsx';
import { fmtEventTime, fmtInt, fmtUsd } from '../lib/format.js';
import { useQuery } from '../lib/useQuery.js';

const PAGE_SIZE = 25;

export default function Orphans() {
  const { api } = useAuth();
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState(null);
  const [message, setMessage] = useState(null);
  const [undoError, setUndoError] = useState(null);
  const formCard = useRef(null);
  useEffect(() => { document.title = 'Orphaned reports · Pure Insights'; }, []);

  const orphans = useQuery(() => api.get('/api/orphans', { limit: PAGE_SIZE, offset }), [api, offset]);
  const audit = useQuery(() => api.get('/api/audit', { limit: 50 }), [api]);

  // Only the newest entry per report counts; if it is an assignment, it can be undone.
  const newestPerReport = new Map();
  for (const entry of audit.data?.data ?? []) if (!newestPerReport.has(entry.report_id)) newestPerReport.set(entry.report_id, entry);
  const undoable = [...newestPerReport.values()].filter((e) => e.action === 'ASSIGN');

  function choose(report) {
    setSelected(report);
    setMessage(null);
    requestAnimationFrame(() => formCard.current?.scrollIntoView?.({ block: 'center' }));
  }

  function assigned(updated) {
    setSelected(null);
    setMessage(`${updated.report_id} is now owned by ${updated.owner_email}. It no longer appears in this list.`);
    orphans.reload();
    audit.reload();
  }

  async function undo(reportId) {
    setUndoError(null);
    try {
      await api.del(`/api/reports/${encodeURIComponent(reportId)}/owner`);
      setMessage(`The assignment for ${reportId} was removed.`);
      orphans.reload();
      audit.reload();
    } catch (err) {
      setUndoError(err.message);
    }
  }

  const rows = orphans.data?.data ?? [];
  return (
    <>
      <PageHeader title="Orphaned reports" description="Reports nobody currently owns. They still cost money, so each needs someone responsible." />

      {message && <p className="success-note" role="status">{message}</p>}
      <ErrorBox error={orphans.error} onRetry={orphans.reload} />
      {!orphans.data && !orphans.error && <Skeleton rows={5} />}

      {orphans.data && (
        <div className="grid-kpi">
          <Kpi label="Reports without an owner" value={fmtInt(orphans.data.page.total)} tone={orphans.data.page.total > 0 ? 'warning' : 'success'} icon="userOff" />
          <Kpi label="Their spend" value={<Money value={orphans.data.meta.orphaned_spend_usd} />} icon="coin" hint="At the placeholder credit price" />
        </div>
      )}
      <PriceBanner meta={orphans.data?.meta} />

      {orphans.data && rows.length === 0 && <EmptyState title="Every report has an owner.">Nothing needs assigning right now.</EmptyState>}
      {rows.length > 0 && (
        <>
          <DataTable
            caption="Reports without an owner"
            rows={rows}
            rowKey={(r) => r.report_id}
            columns={[
              { key: 'r', header: 'Report', render: (r) => (<><Link to={`/reports/${r.report_id}`}>{r.report_id}</Link><div className="muted small">{r.report_name}</div></>) },
              { key: 'last', header: 'Last known owner', render: (r) => (r.last_known_owner_email ? <span className="mono small">{r.last_known_owner_email}</span> : <span className="muted">None on record</span>) },
              { key: 'spend', header: 'Spend', align: 'right', render: (r) => fmtUsd(r.cost?.total_cost_usd) },
              { key: 'n', header: 'Readings with no owner', align: 'right', render: (r) => fmtInt(r.orphan_observation_count) },
              { key: 'act', header: 'Action', render: (r) => <Button variant="secondary" aria-label={`Assign an owner to ${r.report_id}`} onClick={() => choose(r)}>Assign owner</Button> },
            ]}
          />
          <Pagination total={orphans.data.page.total} limit={PAGE_SIZE} offset={offset} noun="reports" onChange={setOffset} />
        </>
      )}

      {selected && (
        <div ref={formCard}>
          <Card title={`Assign an owner to ${selected.report_id}`} subtitle={selected.report_name}>
            <AssignOwnerForm report={selected} onAssigned={assigned} autoFocus />
            <p style={{ marginTop: 'var(--pi-space-3)' }}><Button variant="secondary" onClick={() => setSelected(null)}>Cancel</Button></p>
          </Card>
        </div>
      )}

      <Card title="Recent assignments" subtitle="Anything you assign can be undone here.">
        <ErrorBox error={audit.error} onRetry={audit.reload} />
        {undoError && <p className="field-error" role="alert">{undoError}</p>}
        {audit.data && audit.data.data.length === 0 && <EmptyState title="No assignments yet." />}
        {audit.data && audit.data.data.length > 0 && (
          <DataTable
            caption="Recent owner assignments"
            rows={audit.data.data}
            rowKey={(e) => `${e.at}-${e.report_id}-${e.action}`}
            columns={[
              { key: 'at', header: 'When', render: (e) => new Date(e.at).toLocaleString() },
              { key: 'r', header: 'Report', render: (e) => <Link to={`/reports/${e.report_id}`}>{e.report_id}</Link> },
              { key: 'chg', header: 'Change', render: (e) => (e.action === 'ASSIGN' ? `Assigned to ${e.to}` : `Assignment removed${e.to ? `, back to ${e.to}` : ''}`) },
              { key: 'by', header: 'By', render: (e) => <span className="mono small">{e.actor}</span> },
              {
                key: 'undo', header: 'Undo',
                render: (e) => (undoable.includes(e) ? <Button variant="secondary" aria-label={`Undo the assignment for ${e.report_id}`} onClick={() => undo(e.report_id)}>Undo</Button> : null),
              },
            ]}
          />
        )}
      </Card>
    </>
  );
}
