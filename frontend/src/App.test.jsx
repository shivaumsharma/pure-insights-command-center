import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { alert, baseRoutes, HEALTH, lastSocket, META, page, renderApp, report } from './test/harness.jsx';

const costRow = (id, extra = {}) => ({
  report_id: id, report_name: `Dashboard ${id}`, owner_email: 'user_6@company.com', is_orphaned: false, last_known_owner_email: null,
  attributed_credits: 1000, total_cost_usd: 3500, cost_per_view_usd: 2.5, idle_cost_usd: 0, ...extra,
});

describe('signing in', () => {
  it('asks for both fields before calling the server, and moves focus to the first problem', async () => {
    const { fetchImpl } = renderApp({ path: '/login' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Enter your email address.')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveFocus();
    expect(screen.getByLabelText('Email')).toBeInvalid();
    expect(fetchImpl.calls).toHaveLength(0);

    await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('shows the server\'s message for wrong credentials and keeps the form usable', async () => {
    const { fetchImpl } = renderApp({
      path: '/login',
      routes: { 'POST /api/auth/login': { status: 401, body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } } } },
    });
    await userEvent.type(screen.getByLabelText('Email'), 'a@b.co');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    expect(fetchImpl.callsTo('POST', '/api/auth/login')[0].body).toEqual({ email: 'a@b.co', password: 'wrong' });
  });

  it('on success lands on the overview, remembers the session, and opens the live feed with the token in the first message', async () => {
    renderApp({
      path: '/login',
      routes: {
        ...baseRoutes,
        'POST /api/auth/login': { status: 200, body: { token: 'tok-1', user: { email: 'admin@demo.local', name: 'A', role: 'admin' } } },
        'GET /api/costs/reports': { ...page([]), meta: META },
      },
    });
    await userEvent.type(screen.getByLabelText('Email'), 'admin@demo.local');
    await userEvent.type(screen.getByLabelText('Password'), 'pw');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(JSON.parse(sessionStorage.getItem('pi.session')).token).toBe('tok-1');

    await waitFor(() => expect(lastSocket()).toBeTruthy());
    expect(lastSocket().url).not.toContain('tok-1');
    act(() => lastSocket().open());
    expect(lastSocket().sent).toEqual([{ type: 'auth', token: 'tok-1' }]);
  });

  it('visiting a page while signed out goes to the login screen', () => {
    renderApp({ path: '/reports' });
    expect(screen.getByRole('heading', { name: 'Pure Insights' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
  });
});

describe('what each role can reach', () => {
  const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));

  it('admin sees every section', async () => {
    renderApp({ role: 'admin', routes: { ...baseRoutes, 'GET /api/costs/reports': { ...page([]), meta: META } } });
    await screen.findByRole('heading', { name: 'Overview' });
    for (const name of ['Overview', 'Reports', 'Alerts', 'Costs', 'Orphaned reports', 'Data quality']) expect(nav().getByRole('link', { name })).toBeInTheDocument();
  });

  it('owner sees costs but not admin pages; viewer sees neither', async () => {
    const owner = renderApp({ role: 'owner', routes: { ...baseRoutes, 'GET /api/costs/reports': { ...page([]), meta: META } } });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(nav().getByRole('link', { name: 'Costs' })).toBeInTheDocument();
    expect(nav().queryByRole('link', { name: 'Orphaned reports' })).toBeNull();
    expect(nav().queryByRole('link', { name: 'Data quality' })).toBeNull();
    owner.unmount();

    renderApp({ role: 'viewer', routes: baseRoutes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(nav().queryByRole('link', { name: 'Costs' })).toBeNull();
    expect(nav().queryByRole('link', { name: 'Orphaned reports' })).toBeNull();
  });

  it.each([
    ['viewer', '/costs'],
    ['viewer', '/orphans'],
    ['owner', '/orphans'],
    ['owner', '/data-quality'],
  ])('%s opening %s directly sees "No access" and nothing is fetched for it', async (role, path) => {
    const { fetchImpl } = renderApp({ role, path, routes: baseRoutes });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    const forbidden = ['/api/costs', '/api/orphans', '/api/quarantine', '/api/dq-report', '/api/audit'];
    expect(fetchImpl.calls.filter((c) => forbidden.some((f) => c.path.startsWith(f)))).toEqual([]);
  });

  it('a viewer never sees a cost column or cost sort on the reports page', async () => {
    renderApp({ role: 'viewer', path: '/reports', routes: { ...baseRoutes, 'GET /api/reports': page([report('RPT_1')]) } });
    await screen.findByRole('table', { name: 'Reports' });
    expect(screen.queryByRole('columnheader', { name: 'Cost per view' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'Highest cost' })).toBeNull();
  });
});

describe('reports list', () => {
  const routes = (handler) => ({ ...baseRoutes, 'GET /api/reports': handler });

  it('shows rows with owner, status and a slow badge, and links each report', async () => {
    renderApp({
      role: 'admin', path: '/reports',
      routes: { ...routes(page([report('RPT_1', { latest_load_time_sec: 41.2 }), report('RPT_2', { owner_email: null, is_orphaned: true, last_refresh_status: 'FAILED' })])), 'GET /api/costs/reports': { ...page([]), meta: META } },
    });
    const table = await screen.findByRole('table', { name: 'Reports' });
    expect(within(table).getByRole('link', { name: 'RPT_1' })).toHaveAttribute('href', '/reports/RPT_1');
    expect(within(table).getByText('Slow')).toBeInTheDocument();
    expect(within(table).getByText('No owner')).toBeInTheDocument();
    expect(within(table).getByText('Failed')).toBeInTheDocument();
  });

  it('search, filters and paging all go to the server as query parameters', async () => {
    const { fetchImpl } = renderApp({ role: 'admin', path: '/reports', routes: { ...routes(page([report('RPT_1')], 60)), 'GET /api/costs/reports': { ...page([]), meta: META } } });
    await screen.findByRole('table', { name: 'Reports' });

    await userEvent.type(screen.getByLabelText('Search by ID or name'), 'rpt_29');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(fetchImpl.callsTo('GET', '/api/reports').some((c) => c.url.includes('q=rpt_29'))).toBe(true));

    await userEvent.selectOptions(screen.getByLabelText('Latest refresh'), 'FAILED');
    await waitFor(() => expect(fetchImpl.callsTo('GET', '/api/reports').at(-1).url).toMatch(/status=FAILED/));
    await userEvent.selectOptions(screen.getByLabelText('Ownership'), 'true');
    await waitFor(() => expect(fetchImpl.callsTo('GET', '/api/reports').at(-1).url).toMatch(/orphaned=true/));
    await userEvent.selectOptions(screen.getByLabelText('Sort by'), 'failures');
    await waitFor(() => expect(fetchImpl.callsTo('GET', '/api/reports').at(-1).url).toMatch(/sort=failures/));

    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(fetchImpl.callsTo('GET', '/api/reports').at(-1).url).toMatch(/offset=25/));
    expect(screen.getByText(/Showing 26–50 of 60 reports/)).toBeInTheDocument();
  });

  it('an empty filtered result says so and offers a way back', async () => {
    renderApp({ role: 'admin', path: '/reports?status=FAILED', routes: { ...routes(page([], 0)), 'GET /api/costs/reports': { ...page([]), meta: META } } });
    expect(await screen.findByText('No reports match these filters.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('There are no reports to show yet.')).toBeInTheDocument();
  });

  it('a server error is shown in words with a retry that works', async () => {
    let fail = true;
    renderApp({
      role: 'viewer', path: '/reports',
      routes: routes(() => (fail ? { status: 500, body: { error: { code: 'INTERNAL', message: 'Something went wrong on our side' } } } : { status: 200, body: page([report('RPT_1')]) })),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong on our side');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Reports' })).toBeInTheDocument();
  });
});

describe('orphaned reports', () => {
  const orphan = report('RPT_204', { owner_email: null, is_orphaned: true, last_known_owner_email: 'user_9@company.com', orphan_observation_count: 3, cost: { total_cost_usd: 5000 } });
  const makeRoutes = (extra = {}) => ({
    ...baseRoutes,
    'GET /api/orphans': page([orphan], 1, { meta: { ...META, orphaned_spend_usd: 5000 } }),
    'GET /api/audit': page([]),
    ...extra,
  });

  it('lists unowned reports with their spend and a suggested owner', async () => {
    renderApp({ role: 'admin', path: '/orphans', routes: makeRoutes() });
    const table = await screen.findByRole('table', { name: 'Reports without an owner' });
    expect(within(table).getByText('user_9@company.com')).toBeInTheDocument();
    expect(within(table).getByText('$5,000.00')).toBeInTheDocument();
    expect(screen.getByRole('note')).toHaveTextContent(/placeholder credit price of \$3/);
  });

  it('assigning checks the email first, then sends it, confirms, and refreshes the list', async () => {
    let orphanCalls = 0;
    const routes = makeRoutes({
      'GET /api/orphans': () => (++orphanCalls === 1 ? { status: 200, body: page([orphan], 1, { meta: { ...META, orphaned_spend_usd: 5000 } }) } : { status: 200, body: page([], 0, { meta: { ...META, orphaned_spend_usd: 0 } }) }),
      'PUT /api/reports/RPT_204/owner': { status: 200, body: { data: { ...orphan, owner_email: 'user_6@company.com', is_orphaned: false } } },
    });
    const { fetchImpl } = renderApp({ role: 'admin', path: '/orphans', routes });
    await userEvent.click(await screen.findByRole('button', { name: 'Assign an owner to RPT_204' }));

    const input = await screen.findByLabelText('Owner for RPT_204');
    expect(input).toHaveValue('user_9@company.com'); // suggestion prefilled
    await userEvent.clear(input);
    await userEvent.type(input, 'nope');
    await userEvent.click(screen.getByRole('button', { name: 'Assign owner' }));
    expect(await screen.findByText(/Enter a valid email address/)).toBeInTheDocument();
    expect(fetchImpl.callsTo('PUT', '/api/reports/RPT_204/owner')).toHaveLength(0);

    await userEvent.clear(input);
    await userEvent.type(input, 'user_6@company.com');
    await userEvent.click(screen.getByRole('button', { name: 'Assign owner' }));
    expect(await screen.findByText(/RPT_204 is now owned by user_6@company.com/)).toBeInTheDocument();
    expect(fetchImpl.callsTo('PUT', '/api/reports/RPT_204/owner')[0].body).toEqual({ email: 'user_6@company.com' });
    expect(await screen.findByText('Every report has an owner.')).toBeInTheDocument();
  });

  it('shows the server\'s reason when an assignment is rejected', async () => {
    const routes = makeRoutes({ 'PUT /api/reports/RPT_204/owner': { status: 403, body: { error: { code: 'FORBIDDEN', message: 'You do not have permission to do this' } } } });
    renderApp({ role: 'admin', path: '/orphans', routes });
    await userEvent.click(await screen.findByRole('button', { name: 'Assign an owner to RPT_204' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Assign owner' }));
    expect(await screen.findByText('You do not have permission to do this')).toBeInTheDocument();
  });

  it('offers Undo only for the newest assignment of a report, and removing it calls DELETE', async () => {
    const audit = page([
      { at: '2026-10-12T10:00:00.000Z', actor: 'admin@demo.local', action: 'ASSIGN', report_id: 'RPT_204', from: null, to: 'user_6@company.com' },
      { at: '2026-10-12T09:00:00.000Z', actor: 'admin@demo.local', action: 'ASSIGN', report_id: 'RPT_204', from: null, to: 'user_2@company.com' },
      { at: '2026-10-12T08:00:00.000Z', actor: 'admin@demo.local', action: 'UNASSIGN', report_id: 'RPT_220', from: 'a@b.co', to: null },
    ]);
    const routes = makeRoutes({
      'GET /api/audit': audit,
      'DELETE /api/reports/RPT_204/owner': { status: 200, body: { data: orphan } },
    });
    const { fetchImpl } = renderApp({ role: 'admin', path: '/orphans', routes });
    const undoButtons = await screen.findAllByRole('button', { name: /Undo the assignment/ });
    expect(undoButtons).toHaveLength(1);
    await userEvent.click(undoButtons[0]);
    await waitFor(() => expect(fetchImpl.callsTo('DELETE', '/api/reports/RPT_204/owner')).toHaveLength(1));
    expect(await screen.findByText('The assignment for RPT_204 was removed.')).toBeInTheDocument();
  });
});

describe('costs', () => {
  it('admin sees the trust checks, the deliberate failure explained, and the placeholder price warning', async () => {
    const checks = [
      { check_id: 'R1', description: 'Attributed = metered credits', expected_value: 0, actual_value: 0, status: 'PASS', note: 'count of hours that do not balance' },
      { check_id: 'R8', description: 'Reports outside tolerance', expected_value: 0, actual_value: 64, status: 'FAIL', note: 'the real reconciliation' },
    ];
    renderApp({
      role: 'admin', path: '/costs',
      routes: {
        'GET /api/costs/reports': { ...page([costRow('RPT_299')]), meta: META },
        'GET /api/costs/reconciliation': { data: checks, summary: { pass: 1, fail: 1, info: 0 }, meta: META },
        'GET /api/costs/variance': { ...page([{ report_id: 'RPT_299', reported_credits: 100, attributed_credits: 150, difference: 50, variance_pct: 50, status: 'OUTSIDE_TOLERANCE' }]), meta: META },
        'GET /api/costs/aws-mismatch': { ...page([]), meta: META },
      },
    });
    expect(await screen.findByText('1 passed, 1 failed, 0 for information.')).toBeInTheDocument();
    expect(screen.getByText('Passed')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText(/One check fails on purpose/)).toBeInTheDocument();
    expect(screen.getAllByText(/placeholder credit price/).length).toBeGreaterThan(0);
    const variance = await screen.findByRole('table', { name: /claimed credits disagree/ });
    expect(within(variance).getByText('+50%')).toBeInTheDocument();
  });

  it('an owner gets only their own cost table, with no admin sections requested', async () => {
    const { fetchImpl } = renderApp({ role: 'owner', path: '/costs', routes: { 'GET /api/costs/reports': { ...page([costRow('RPT_206')]), meta: META } } });
    await screen.findByRole('table', { name: 'Cost per report' });
    expect(screen.queryByText('Can we trust these numbers?')).toBeNull();
    expect(fetchImpl.calls.map((c) => c.path).filter((p) => /reconciliation|variance|aws-mismatch/.test(p))).toEqual([]);
  });
});

describe('report detail', () => {
  it('an unknown or someone else\'s report gets a friendly page, not an error dump', async () => {
    renderApp({ role: 'owner', path: '/reports/RPT_200', routes: { ...baseRoutes, 'GET /api/reports/RPT_200': { status: 404, body: { error: { code: 'NOT_FOUND', message: 'Report not found' } } } } });
    expect(await screen.findByRole('heading', { name: 'Report not found' })).toBeInTheDocument();
    expect(screen.getByText(/may belong to someone else/)).toBeInTheDocument();
  });

  it('shows the chart with a text alternative, and cost only when the API returned it', async () => {
    const obs = (i, load) => ({ observation_id: `RPT_1:${i}`, observed_at: `2026-09-01T0${i}:00:00.000Z`, last_refresh_status: 'SUCCESS', avg_load_time_sec: load, monthly_active_views: 10, concurrent_user_peak: 3, owner_email: null, latency_breach: load > 15 });
    renderApp({
      role: 'viewer', path: '/reports/RPT_1',
      routes: { ...baseRoutes, 'GET /api/reports/RPT_1': { data: { ...report('RPT_1'), recent_observations: [obs(3, 30), obs(2, 10), obs(1, 20)] } } },
    });
    const chart = await screen.findByRole('img', { name: /Load time over the last 3 readings; highest 30 seconds/ });
    expect(chart).toBeInTheDocument();
    expect(screen.getByText('Cost details are not available for your role.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Assign owner' })).toBeNull(); // admin-only
  });
});

describe('live alerts', () => {
  async function signedInOverview(role = 'admin') {
    renderApp({ role, routes: { ...baseRoutes, 'GET /api/costs/reports': { ...page([]), meta: META } } });
    await screen.findByRole('heading', { name: 'Overview' });
    await waitFor(() => expect(lastSocket()).toBeTruthy());
    act(() => lastSocket().open());
    act(() => lastSocket().receive({ type: 'ready', last_event_id: 0 }));
  }

  it('shows the connection state and new alerts as they arrive', async () => {
    await signedInOverview();
    await waitFor(() => expect(document.querySelector('.live-pill')).toHaveTextContent('Alerts: Live'));
    expect(document.querySelector('.live-pill')).toHaveAttribute('role', 'status');
    expect(screen.getByText('Waiting for the first alert…')).toBeInTheDocument();

    act(() => lastSocket().receive(alert(1)));
    const feed = await screen.findByRole('list', { name: 'Latest alerts' });
    expect(within(feed).getByText('RPT_201 load time 41.2 s is over 15 s (high)')).toBeInTheDocument();
    expect(within(feed).getByText('High')).toBeInTheDocument();
    expect(within(feed).getByText('New')).toBeInTheDocument();
  });

  it('a resolved alert leads with "Resolved" and shows its old severity as plain text, not as a severity badge', async () => {
    await signedInOverview();
    act(() => lastSocket().receive(alert(1, { lifecycle: 'RESOLVED', severity: 'high', message: 'RPT_201 is back under 15 s (41.2 s)' })));
    const feed = await screen.findByRole('list', { name: 'Latest alerts' });
    expect(within(feed).getByText('Resolved')).toBeInTheDocument();
    expect(within(feed).queryByText('High')).toBeNull();
    expect(within(feed).getByText(/was high/)).toBeInTheDocument();
  });

  it('says so when the connection drops, and reconnects asking for what it missed', async () => {
    await signedInOverview();
    act(() => lastSocket().receive(alert(1)));
    act(() => lastSocket().receive(alert(2, { report_id: 'RPT_5', message: 'RPT_5 refresh failed (high)', alert_type: 'REFRESH_FAILURE' })));
    act(() => lastSocket().drop(1006));
    await waitFor(() => expect(document.querySelector('.live-pill')).toHaveTextContent('Alerts: Reconnecting…'));
  });

  it('a rejected token (4401) signs the user out with an explanation', async () => {
    await signedInOverview();
    act(() => lastSocket().drop(4401));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has expired');
    expect(sessionStorage.getItem('pi.session')).toBeNull();
  });
});

describe('session expiry', () => {
  it('a 401 from any request returns to the sign-in screen with a notice', async () => {
    renderApp({ role: 'viewer', path: '/reports', routes: { ...baseRoutes, 'GET /api/reports': { status: 401, body: { error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } } } } });
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Your session has expired');
  });

  it('signing out clears the session and the socket', async () => {
    renderApp({ role: 'viewer', routes: baseRoutes });
    await screen.findByRole('heading', { name: 'Overview' });
    await userEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByLabelText('Email')).toBeInTheDocument();
    expect(sessionStorage.getItem('pi.session')).toBeNull();
  });
});

describe('open alert counts', () => {
  it('come from the severity counts in the response, asking for a single row instead of the whole list', async () => {
    const { fetchImpl } = renderApp({
      role: 'viewer',
      routes: { ...baseRoutes, 'GET /api/alerts/active': { ...page([{ report_id: 'RPT_1', alert_type: 'LATENCY', severity: 'critical', since: '2026-09-01T00:00:00.000Z', suppressed_since_last: 0 }], 143), meta: { last_event_id: 5, by_severity: { critical: 3, high: 115, medium: 12, low: 13 } } } },
    });
    const group = await screen.findByRole('group', { name: '143 open alerts by severity' });
    expect(within(group).getByText('Critical').parentElement).toHaveTextContent('3');
    expect(within(group).getByText('High').parentElement).toHaveTextContent('115');
    expect(fetchImpl.callsTo('GET', '/api/alerts/active')[0].url).toContain('limit=1');
  });
});

describe('overview numbers come straight from the API', () => {
  it('KPI cards and the status bar describe the health payload', async () => {
    renderApp({ role: 'viewer', routes: baseRoutes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(await screen.findByText('28.1%')).toBeInTheDocument();
    expect(screen.getByText('74.4%')).toBeInTheDocument();
    expect(screen.getByText('13')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Healthy 72, failed 15, timed out 8, unknown 5' })).toBeInTheDocument();
    expect(HEALTH.reports.total).toBe(100);
  });
});
