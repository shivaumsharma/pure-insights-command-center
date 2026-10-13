// The charts as they appear on each page: what is drawn from the API's numbers, and which requests each role does and does not make.

import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { baseRoutes, META, page, renderApp, report } from './test/harness.jsx';

const cost = (id, total, extra = {}) => ({
  report_id: id, report_name: `Dashboard ${id}`, observations: 20, total_views: 1000, attributed_credits: total / 3, credit_cost_usd: total * 0.9, aws_cost_usd: total * 0.1,
  total_cost_usd: total, cost_per_view_usd: total / 1000, idle_cost_usd: 0, owner_email: 'user_6@company.com', is_orphaned: false, last_known_owner_email: 'user_6@company.com', ...extra,
});
const COSTS = [cost('RPT_1', 9000, { idle_cost_usd: 900 }), cost('RPT_2', 3000, { is_orphaned: true, owner_email: null }), cost('RPT_3', 1000)];
const costRoutes = { 'GET /api/costs/reports': { ...page(COSTS), meta: META } };

const REPORTS = [
  report('RPT_200', { last_refresh_status: 'SUCCESS', latest_load_time_sec: 10 }),
  report('RPT_201', { last_refresh_status: 'FAILED', latest_load_time_sec: 40 }),
  report('RPT_202', { last_refresh_status: 'SUCCESS', latest_load_time_sec: 20 }),
];
const overviewRoutes = { ...baseRoutes, 'GET /api/reports': page(REPORTS), ...costRoutes };

describe('overview charts', () => {
  it('shows one tile per report, from the reports the API returned, each linking to its page', async () => {
    renderApp({ role: 'viewer', routes: overviewRoutes });
    const map = await screen.findByRole('list', { name: 'Fleet map: 3 reports' });
    expect(within(map).getAllByRole('link')).toHaveLength(3);
    expect(within(map).getByRole('link', { name: /RPT_201: refresh failed, load time 40.0 s \(over the limit\)/ })).toHaveAttribute('href', '/reports/RPT_201');
    expect(within(map).getByRole('link', { name: 'RPT_200: refresh healthy, load time 10.0 s' })).toBeInTheDocument();
  });

  it('draws the open alerts as bars with the counts the server gave, in words as well', async () => {
    renderApp({
      role: 'viewer',
      routes: { ...overviewRoutes, 'GET /api/alerts/active': { ...page([{ report_id: 'RPT_1' }], 30), meta: { last_event_id: 1, by_severity: { critical: 3, high: 20, medium: 5, low: 2 } } } },
    });
    const bars = await screen.findByRole('list', { name: 'Open alerts by severity' });
    const rows = within(bars).getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual(['Critical3', 'High20', 'Medium5', 'Low2']);
  });

  it('admin sees how breaching readings became alerts, with the share held back worked out from the counters', async () => {
    const { fetchImpl } = renderApp({ role: 'admin', routes: overviewRoutes });
    const bars = await screen.findByRole('list', { name: 'How breaching readings became alerts' });
    expect(within(bars).getByText('Readings that breached').closest('li')).toHaveTextContent('10'); // 6 slow + 4 failed
    expect(within(bars).getByText('Alerts sent').closest('li')).toHaveTextContent('4'); // 2 new + 1 worse + 1 still open
    expect(within(bars).getByText('Resolved').closest('li')).toHaveTextContent('3');
    expect(screen.getByText('60%').closest('p')).toHaveTextContent('60% of breaching readings were held back'); // 6 of 10
    expect(fetchImpl.callsTo('GET', '/api/alerts/summary')).toHaveLength(1);
  });

  it.each(['viewer', 'owner'])('%s never asks for the admin-only alert counters, and sees no alert-noise card', async (role) => {
    const { fetchImpl } = renderApp({ role, routes: overviewRoutes });
    await screen.findByRole('list', { name: 'Fleet map: 3 reports' });
    expect(screen.queryByText('Alert noise')).toBeNull();
    expect(fetchImpl.callsTo('GET', '/api/alerts/summary')).toEqual([]);
  });

  it('a viewer sees no money anywhere and never asks for cost data', async () => {
    const { fetchImpl } = renderApp({ role: 'viewer', routes: overviewRoutes });
    await screen.findByRole('list', { name: 'Fleet map: 3 reports' });
    expect(screen.queryByText('Biggest spenders')).toBeNull();
    expect(screen.queryByText('What the money pays for')).toBeNull();
    expect(fetchImpl.calls.filter((c) => c.path.startsWith('/api/costs'))).toEqual([]);
    expect(document.body.textContent).not.toMatch(/\$\d/);
  });

  it('cost charts are drawn from the cost rows: biggest first with the idle part, and the splits add up', async () => {
    renderApp({ role: 'owner', routes: overviewRoutes });
    const bars = await screen.findByRole('list', { name: 'The eight most expensive reports' });
    expect(within(bars).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['RPT_1$9,000.00', 'RPT_2$3,000.00', 'RPT_3$1,000.00']);
    expect(screen.getByRole('img', { name: 'Snowflake credits $11,700.00, hosting $1,300.00' })).toBeInTheDocument(); // 90% / 10% of 13,000
    expect(screen.getByRole('img', { name: 'Owned $10,000.00, with no owner $3,000.00' })).toBeInTheDocument();
    expect(screen.getByText('23%')).toBeInTheDocument(); // 3,000 of 13,000
  });

  it('the cost chart has a table behind it, built only when asked for', async () => {
    renderApp({ role: 'owner', routes: overviewRoutes });
    await screen.findByRole('list', { name: 'The eight most expensive reports' });
    expect(screen.queryByRole('table', { name: 'Most expensive reports' })).toBeNull();
    screen.getByText('View the numbers as a table').click();
    expect(await screen.findByRole('table', { name: 'Most expensive reports' })).toBeInTheDocument();
  });

  it('a failing chart request is shown in its own card, and the rest of the page still works', async () => {
    renderApp({ role: 'viewer', routes: { ...overviewRoutes, 'GET /api/reports': { status: 500, body: { error: { code: 'INTERNAL', message: 'Something broke' } } } } });
    expect(await screen.findByText('Latest refresh status')).toBeInTheDocument();
    const card = (await screen.findByRole('heading', { name: 'Fleet map' })).closest('section');
    expect(await within(card).findByRole('alert')).toHaveTextContent('Something broke');
    expect(screen.getByText('28.1%')).toBeInTheDocument();
  });
});

describe('costs page charts', () => {
  const variance = [
    { report_id: 'RPT_1', reported_credits: 100, attributed_credits: 105, difference: 5, variance_pct: 5, status: 'WITHIN_TOLERANCE' },
    { report_id: 'RPT_2', reported_credits: 100, attributed_credits: 300, difference: 200, variance_pct: 200, status: 'OUTSIDE_TOLERANCE' },
    { report_id: 'RPT_3', reported_credits: null, attributed_credits: 50, difference: null, variance_pct: null, status: 'NO_CLAIM' },
  ];
  const adminRoutes = {
    ...costRoutes,
    'GET /api/costs/reconciliation': { data: [], summary: { pass: 0, fail: 0, info: 0 }, meta: META },
    'GET /api/costs/variance': { ...page(variance), meta: META },
    'GET /api/costs/aws-mismatch': { ...page([]), meta: META },
  };

  it('admin gets the claimed-against-implied plot, counting the reports that disagree', async () => {
    renderApp({ role: 'admin', path: '/costs', routes: adminRoutes });
    expect(await screen.findByRole('img', { name: 'Claimed against implied credits for 3 reports; 1 disagree by more than 10 percent' })).toBeInTheDocument();
    expect(screen.getByText(/most marks sit far from the line/)).toBeInTheDocument();
  });

  it('ranks cost per view and idle spend from every report, not just the page of the table', async () => {
    const { fetchImpl } = renderApp({ role: 'admin', path: '/costs', routes: adminRoutes });
    const perView = await screen.findByRole('list', { name: 'Ten highest costs per view' });
    expect(within(perView).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['RPT_1$9.00', 'RPT_2$3.00', 'RPT_3$1.00']);
    const idle = screen.getByRole('list', { name: 'Ten largest idle spends' });
    expect(within(idle).getAllByRole('listitem')).toHaveLength(1); // only RPT_1 had idle spend
    expect(within(idle).getByText('RPT_1').closest('li')).toHaveTextContent('$900.00');
    expect(fetchImpl.callsTo('GET', '/api/costs/reports').some((c) => c.url.includes('limit=200'))).toBe(true);
  });

  it('an owner gets the rankings but not the admin plot, and never asks for admin data', async () => {
    const { fetchImpl } = renderApp({ role: 'owner', path: '/costs', routes: costRoutes });
    await screen.findByRole('list', { name: 'Ten highest costs per view' });
    expect(screen.queryByText('Claimed against implied credits')).toBeNull();
    expect(fetchImpl.calls.map((c) => c.path).filter((p) => /reconciliation|variance|aws-mismatch/.test(p))).toEqual([]);
  });

  it('says so when no report had idle spend', async () => {
    renderApp({ role: 'owner', path: '/costs', routes: { 'GET /api/costs/reports': { ...page([cost('RPT_1', 100)]), meta: META } } });
    expect(await screen.findByText('No idle spend.')).toBeInTheDocument();
  });
});

describe('report detail charts', () => {
  const obs = (i, status, load, views = 100 * i, peak = 5 * i) => ({
    observation_id: `RPT_1:${i}`, observed_at: `2026-09-01T0${i}:00:00.000Z`, last_refresh_status: status, avg_load_time_sec: load,
    monthly_active_views: views, concurrent_user_peak: peak, owner_email: null, latency_breach: load > 15,
  });
  const detail = (cost) => ({ data: { ...report('RPT_1'), ...(cost ? { cost } : {}), recent_observations: [obs(4, 'SUCCESS', 12), obs(3, 'FAILED', 30), obs(2, 'UNKNOWN', 20), obs(1, 'SUCCESS', 8)] } });

  it('marks a failed refresh on the load-time chart, and draws views and concurrent users beside it', async () => {
    renderApp({ role: 'viewer', path: '/reports/RPT_1', routes: { ...baseRoutes, 'GET /api/reports/RPT_1': detail() } });
    const chart = await screen.findByRole('img', { name: /^Load time over the last 4 readings/ });
    expect(chart.querySelectorAll('polygon.mk-bad')).toHaveLength(1);
    expect(chart.querySelectorAll('circle.mk-unknown')).toHaveLength(1);
    expect(screen.getByRole('img', { name: 'Monthly active views over the last 4 readings; highest 400, lowest 100' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Peak concurrent users over the last 4 readings; highest 20, lowest 5' })).toBeInTheDocument();
  });

  it('shows how this report\'s spend splits only when the API returned a cost', async () => {
    const withCost = renderApp({
      role: 'admin', path: '/reports/RPT_1',
      routes: { ...baseRoutes, 'GET /api/reports/RPT_1': { ...detail({ attributed_credits: 10, total_cost_usd: 1000, cost_per_view_usd: 1, idle_cost_usd: 250 }), meta: META } },
    });
    const split = await screen.findByRole('list', { name: "How this report's spend splits between use and idle time" });
    expect(split).toHaveTextContent('$1,000.00');
    withCost.unmount();
    renderApp({ role: 'viewer', path: '/reports/RPT_1', routes: { ...baseRoutes, 'GET /api/reports/RPT_1': detail() } });
    await screen.findByText('Cost details are not available for your role.');
    expect(screen.queryByRole('list', { name: /spend splits/ })).toBeNull();
  });
});

describe('alert rows', () => {
  it('an open alert is edged by its severity and a resolved one in green, whatever its old severity was', async () => {
    const mk = (id, extra) => ({ type: 'alert', event_id: id, alert_type: 'LATENCY', lifecycle: 'TRIGGERED', severity: 'high', report_id: 'RPT_1', report_name: 'x', observation_id: `o${id}`, observed_at: '2026-09-01T03:00:30.000Z', suppressed_since_last: 0, value: 41, threshold: 15, message: `message ${id}`, ...extra });
    renderApp({ role: 'viewer', path: '/alerts', routes: { ...baseRoutes, 'GET /api/alerts': { ...page([mk(2, { lifecycle: 'RESOLVED', severity: 'critical' }), mk(1, { severity: 'medium' })]), meta: { last_event_id: 2, oldest_event_id: 1 } } } });
    const list = await screen.findByRole('list', { name: 'Alert history' });
    const [resolved, open] = within(list).getAllByRole('listitem');
    expect(resolved).toHaveAttribute('data-sev', 'resolved');
    expect(open).toHaveAttribute('data-sev', 'medium');
  });
});

describe('data quality and alerts', () => {
  it('draws where the rows went and why they were set aside, with the counts in words', async () => {
    const dq = {
      rows: { in: 2000, clean: 1976, quarantined: 24, conserved: true }, quarantine_by_reason: { NEGATIVE_CREDITS: 24 },
      flags_on_clean_rows: { orphan_observations: 242, status_unknown: 98, zero_views: 4, concurrency_exceeds_views: 91 },
    };
    renderApp({ role: 'admin', path: '/data-quality', routes: { ...baseRoutes, 'GET /api/dq-report': { data: dq }, 'GET /api/quarantine': page([]) } });
    const rows = await screen.findByRole('list', { name: 'Rows used and rows set aside' });
    expect(rows).toHaveTextContent('2,000');
    expect(within(rows.closest('.stackbars')).getByText('Used').closest('li')).toHaveTextContent('Used 1,976');
    const why = screen.getByRole('list', { name: 'Rows set aside, by reason' });
    expect(within(why).getByText('Negative Snowflake credits').closest('li')).toHaveTextContent('24');
    const flags = screen.getByRole('list', { name: 'Rows kept but flagged' });
    expect(within(flags).getByText('Readings with no owner').closest('li')).toHaveTextContent('242');
  });

  it('the alerts page splits the open alerts by severity, and edges each open alert by its severity', async () => {
    renderApp({
      role: 'viewer', path: '/alerts',
      routes: {
        ...baseRoutes,
        'GET /api/alerts/active': { ...page([{ report_id: 'RPT_1', alert_type: 'LATENCY', severity: 'critical', since: '2026-09-01T00:00:00.000Z', suppressed_since_last: 0 }], 12), meta: { last_event_id: 1, by_severity: { critical: 2, high: 6, medium: 3, low: 1 } } },
      },
    });
    const bar = await screen.findByRole('list', { name: 'Open alerts by severity' });
    expect(bar).toHaveTextContent('12');
    const legend = bar.closest('.stackbars').querySelector('.legend');
    expect([...legend.querySelectorAll('li')].map((li) => li.textContent.trim())).toEqual(['Critical 2', 'High 6', 'Medium 3', 'Low 1']);
    const list = await screen.findByRole('list', { name: 'Open alerts' });
    await waitFor(() => expect(list.querySelector('li')).toHaveAttribute('data-sev', 'critical'));
  });
});
