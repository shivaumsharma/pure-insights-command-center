import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Scatter } from '../components/charts/Scatter.jsx';
import { BarList } from '../components/charts/StackBars.jsx';
import { Badge, Card, DataTable, EmptyState, ErrorBox, Field, OwnerCell, PageHeader, Pagination, PriceBanner, Skeleton } from '../components/ui.jsx';
import { describeCheck } from '../lib/checkCopy.js';
import { fmtCredits, fmtEventTime, fmtInt, fmtUsd } from '../lib/format.js';
import { topBy } from '../lib/summaries.js';
import { useQuery } from '../lib/useQuery.js';

const COST_SORTS = [['total_cost', 'Highest total cost'], ['cost_per_view', 'Highest cost per view'], ['idle_cost', 'Most idle spend']];
const MISMATCH_LABEL = { COST_HIGH_FOR_USAGE: 'Cost high for usage', COST_LOW_FOR_USAGE: 'Cost low for usage', ZERO_VIEWS_WITH_COST: 'No views, still paying' };
const CHECK_TONE = { PASS: 'success', FAIL: 'danger', INFO: 'info' };
const CHECK_LABEL = { PASS: 'Passed', FAIL: 'Failed', INFO: 'For information' };

function Loading({ query, rows = 4 }) {
  return (
    <>
      <ErrorBox error={query.error} onRetry={query.reload} />
      {!query.data && !query.error && <Skeleton rows={rows} />}
    </>
  );
}

export default function Costs() {
  const { api, user } = useAuth();
  const isAdmin = user.role === 'admin';
  const [sort, setSort] = useState('total_cost');
  const [costOffset, setCostOffset] = useState(0);
  const [varOffset, setVarOffset] = useState(0);
  const [awsType, setAwsType] = useState('');
  const [awsOffset, setAwsOffset] = useState(0);
  useEffect(() => { document.title = 'Costs · Pure Insights'; }, []);

  const costs = useQuery(() => api.get('/api/costs/reports', { sort, limit: 15, offset: costOffset }), [api, sort, costOffset]);
  // The charts look at every report at once (the table above pages through them).
  const everyCost = useQuery(() => api.get('/api/costs/reports', { limit: 200 }), [api]);
  const everyVariance = useQuery(() => api.get('/api/costs/variance', { limit: 200 }), [api], { enabled: isAdmin });
  const checks = useQuery(() => api.get('/api/costs/reconciliation'), [api], { enabled: isAdmin });
  const variance = useQuery(() => api.get('/api/costs/variance', { status: 'OUTSIDE_TOLERANCE', limit: 10, offset: varOffset }), [api, varOffset], { enabled: isAdmin });
  const aws = useQuery(() => api.get('/api/costs/aws-mismatch', { type: awsType, limit: 10, offset: awsOffset }), [api, awsType, awsOffset], { enabled: isAdmin });
  const usage = useQuery(() => api.get('/api/costs/aws-usage'), [api], { enabled: isAdmin }); // every reading, for the chart

  const failing = checks.data?.data.some((c) => c.status === 'FAIL');
  const perView = topBy(everyCost.data?.data ?? [], 'cost_per_view_usd', 10);
  const idle = topBy(everyCost.data?.data ?? [], 'idle_cost_usd', 10);
  const plotted = everyVariance.data?.data ?? [];
  const offCount = plotted.filter((v) => v.status === 'OUTSIDE_TOLERANCE').length;
  const readings = usage.data?.data ?? [];
  const rate = usage.data?.meta.fleet_aws_per_view;
  const ratio = usage.data?.meta.mismatch_ratio;
  const outside = readings.filter((r) => r.mismatch_type !== null).length;

  return (
    <>
      <PageHeader
        title="Costs"
        description={isAdmin ? 'What each report costs, and whether the numbers can be trusted.' : 'What the reports you own cost.'}
      />
      <PriceBanner meta={costs.data?.meta} />

      {isAdmin && (
        <Card title="Can we trust these numbers?" subtitle="Each check re-derives the cost figures from the raw usage logs.">
          <Loading query={checks} rows={4} />
          {checks.data && (
            <>
              <p className="small" style={{ marginBottom: 'var(--pi-space-3)' }}>
                {checks.data.summary.pass} passed, {checks.data.summary.fail} failed, {checks.data.summary.info} for information.
              </p>
              <DataTable
                caption="Reconciliation checks"
                rows={checks.data.data}
                rowKey={(c) => c.check_id}
                columns={[
                  {
                    key: 'id', header: 'Check',
                    render: (c) => {
                      const copy = describeCheck(c);
                      return (
                        <>
                          <div><span className="mono small muted">{c.check_id}</span> <strong>{copy.name}</strong></div>
                          <div className="muted small">{copy.why}</div>
                        </>
                      );
                    },
                  },
                  { key: 'status', header: 'Result', render: (c) => <Badge tone={CHECK_TONE[c.status]}>{CHECK_LABEL[c.status]}</Badge> },
                  { key: 'expected', header: 'Expected', align: 'right', render: (c) => fmtCredits(c.expected_value) },
                  { key: 'actual', header: 'Actual', align: 'right', render: (c) => fmtCredits(c.actual_value) },
                ]}
              />
              {failing && (
                <p className="notice" role="note" style={{ marginTop: 'var(--pi-space-4)' }}>
                  One check fails on purpose. It compares the credits each report is <em>claimed</em> to use with the credits its query workload implies.
                  In this synthetic data the two are unrelated, so most reports disagree. That shows the check works. It is not evidence that a real report is mis-billed.
                </p>
              )}
            </>
          )}
        </Card>
      )}

      {isAdmin && (
        <Card title="Claimed against implied credits" subtitle="Each mark is a report. On the dashed line, the credits it is claimed to use match what its queries imply. The further off, the bigger the gap.">
          <Loading query={everyVariance} rows={4} />
          {everyVariance.data && (
            <>
              <Scatter
                points={plotted.map((v) => ({ key: v.report_id, label: v.report_id, x: v.reported_credits, y: v.attributed_credits, off: v.status === 'OUTSIDE_TOLERANCE' }))}
                xTitle="Credits claimed" yTitle="Credits implied by queries" diagonalLabel="claimed = implied" formatValue={fmtCredits}
                ariaLabel={`Claimed against implied credits for ${plotted.length} reports; ${offCount} disagree by more than 10 percent`}
              />
              <p className="muted small section-note">In this synthetic data the two figures are unrelated, so most marks sit far from the line. That shows the check works. It is not evidence that a real report is mis-billed.</p>
            </>
          )}
        </Card>
      )}

      {isAdmin && (
        <Card title="Reports to review" subtitle="Claimed credits differ from the query logs by more than 10%. Biggest gaps first.">
          <Loading query={variance} />
          {variance.data && variance.data.data.length === 0 && <EmptyState title="Every report agrees with the usage logs." />}
          {variance.data && variance.data.data.length > 0 && (
            <>
              <DataTable
                caption="Reports whose claimed credits disagree with the usage logs"
                rows={variance.data.data}
                rowKey={(v) => v.report_id}
                columns={[
                  { key: 'r', header: 'Report', render: (v) => <Link to={`/reports/${v.report_id}`}>{v.report_id}</Link> },
                  { key: 'claimed', header: 'Claimed credits', align: 'right', render: (v) => fmtCredits(v.reported_credits) },
                  { key: 'implied', header: 'Credits from usage logs', align: 'right', render: (v) => fmtCredits(v.attributed_credits) },
                  { key: 'diff', header: 'Difference', align: 'right', render: (v) => `${v.difference > 0 ? '+' : ''}${fmtCredits(v.difference)}` },
                  { key: 'pct', header: 'Gap', align: 'right', render: (v) => (v.variance_pct === null ? '—' : `${v.variance_pct > 0 ? '+' : ''}${v.variance_pct}%`) },
                ]}
              />
              <Pagination total={variance.data.page.total} limit={10} offset={varOffset} noun="reports" onChange={setVarOffset} />
            </>
          )}
        </Card>
      )}

      <div className="grid-2">
        <Card title="Highest cost per view" subtitle="Attributed credits plus hosting, divided by active views.">
          <Loading query={everyCost} rows={4} />
          {everyCost.data && (perView.length === 0 ? <EmptyState title="No cost data to show." /> : (
            <BarList label="Ten highest costs per view" rows={perView.map((r) => ({ key: r.report_id, label: r.report_id, to: `/reports/${r.report_id}`, value: r.cost_per_view_usd, tone: 'brand', valueText: fmtUsd(r.cost_per_view_usd) }))} />
          ))}
        </Card>
        <Card title="Most idle spend" subtitle="Money spent in readings when nobody was viewing the report.">
          <Loading query={everyCost} rows={4} />
          {everyCost.data && (idle.length === 0 ? <EmptyState icon="check" title="No idle spend.">Every reading had views.</EmptyState> : (
            <BarList label="Ten largest idle spends" rows={idle.map((r) => ({ key: r.report_id, label: r.report_id, to: `/reports/${r.report_id}`, value: r.idle_cost_usd, tone: 'warning', valueText: fmtUsd(r.idle_cost_usd) }))} />
          ))}
        </Card>
      </div>

      <Card
        title="Cost per report"
        subtitle="Attributed credits plus hosting, divided by active views."
        actions={
          <Field id="cost-sort" label="Sort by">
            <select id="cost-sort" value={sort} onChange={(e) => { setSort(e.target.value); setCostOffset(0); }}>
              {COST_SORTS.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
          </Field>
        }
      >
        <Loading query={costs} rows={6} />
        {costs.data && costs.data.data.length === 0 && <EmptyState title="No cost data to show." />}
        {costs.data && costs.data.data.length > 0 && (
          <>
            <DataTable
              caption="Cost per report"
              rows={costs.data.data}
              rowKey={(r) => r.report_id}
              columns={[
                { key: 'r', header: 'Report', render: (r) => <Link to={`/reports/${r.report_id}`}>{r.report_id}</Link> },
                { key: 'o', header: 'Owner', render: (r) => <OwnerCell report={r} /> },
                { key: 'cr', header: 'Credits', align: 'right', render: (r) => fmtCredits(r.attributed_credits) },
                { key: 't', header: 'Total cost', align: 'right', render: (r) => fmtUsd(r.total_cost_usd) },
                { key: 'v', header: 'Cost per view', align: 'right', render: (r) => fmtUsd(r.cost_per_view_usd) },
                { key: 'i', header: 'Idle spend', align: 'right', render: (r) => fmtUsd(r.idle_cost_usd) },
              ]}
            />
            <Pagination total={costs.data.page.total} limit={15} offset={costOffset} noun="reports" onChange={setCostOffset} />
          </>
        )}
      </Card>

      {isAdmin && (
        <Card
          title="Hosting cost against active views"
          subtitle="Each mark is one reading. If hosting cost followed usage, the marks would hug the solid line, the fleet's average cost per view."
        >
          <Loading query={usage} rows={4} />
          {usage.data && readings.length > 0 && (
            <>
              <Scatter
                sameScale={false}
                points={readings.map((r) => ({ key: r.observation_id, label: r.report_id, x: r.views, y: r.aws_cost_usd, off: r.mismatch_type !== null }))}
                lines={[
                  { slope: rate, label: 'fleet average', tone: 'main' },
                  { slope: rate * ratio, label: `${ratio}x the average` },
                  { slope: rate / ratio, label: `1/${ratio} of the average` },
                ]}
                xTitle="Active views" yTitle="Hosting cost" formatX={fmtInt} formatY={fmtUsd}
                onLabel={`Within ${ratio}x of the average`} offLabel={`Outside it (${fmtInt(outside)})`}
                ariaLabel={`Hosting cost against active views for ${fmtInt(readings.length)} readings; ${fmtInt(outside)} cost more than ${ratio} times, or less than 1/${ratio} of, what their views predict`}
              />
              <p className="muted small section-note">
                The fleet averages {fmtUsd(rate)} of hosting per view. Marks above the upper dashed line cost {ratio}x or more than their views predict; marks below
                the lower one cost 1/{ratio} or less; marks on the left edge have no views at all yet still cost money. {fmtInt(outside)} of {fmtInt(readings.length)} readings fall outside.
                In this synthetic data cost and views are unrelated, so the marks form a cloud instead of hugging the line. That shows the check works; it says nothing about
                a real report. Active users are approximated by monthly active views, and the {ratio}x line is my choice.
              </p>
            </>
          )}
        </Card>
      )}

      {isAdmin && (
        <Card
          title="Hosting cost that does not fit usage"
          subtitle="Readings where AWS spend is far above or below what the view count predicts. A prompt to investigate, not a verdict."
          actions={
            <Field id="aws-type" label="Show">
              <select id="aws-type" value={awsType} onChange={(e) => { setAwsType(e.target.value); setAwsOffset(0); }}>
                <option value="">All</option>
                {Object.entries(MISMATCH_LABEL).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
              </select>
            </Field>
          }
        >
          <Loading query={aws} />
          {aws.data && aws.data.data.length === 0 && <EmptyState title="No readings match." />}
          {aws.data && aws.data.data.length > 0 && (
            <>
              <DataTable
                caption="Hosting cost that does not fit usage"
                rows={aws.data.data}
                rowKey={(a) => a.observation_id}
                columns={[
                  { key: 'r', header: 'Report', render: (a) => <Link to={`/reports/${a.report_id}`}>{a.report_id}</Link> },
                  { key: 'w', header: 'When', render: (a) => fmtEventTime(a.observed_at) },
                  { key: 'views', header: 'Views', align: 'right', render: (a) => fmtInt(a.monthly_active_views) },
                  { key: 'aws', header: 'Hosting cost', align: 'right', render: (a) => fmtUsd(a.aws_cost_usd) },
                  { key: 'exp', header: 'Expected', align: 'right', render: (a) => fmtUsd(a.expected_aws_usd) },
                  { key: 'ex', header: 'Excess', align: 'right', render: (a) => fmtUsd(a.excess_aws_usd) },
                  { key: 't', header: 'Why flagged', render: (a) => <Badge tone={a.mismatch_type === 'COST_LOW_FOR_USAGE' ? 'info' : 'warning'}>{MISMATCH_LABEL[a.mismatch_type]}</Badge> },
                ]}
              />
              <Pagination total={aws.data.page.total} limit={10} offset={awsOffset} noun="readings" onChange={setAwsOffset} />
            </>
          )}
        </Card>
      )}
    </>
  );
}
