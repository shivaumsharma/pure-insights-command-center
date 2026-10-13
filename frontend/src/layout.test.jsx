// The side menu and the header, and the "Last 10 | All" switch on a report's charts.

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { firstName, partOfDay } from './components/Layout.jsx';
import { baseRoutes, META, page, renderApp, report } from './test/harness.jsx';

const menu = () => within(screen.getByRole('navigation', { name: 'Main' }));
const groups = () => menu().getAllByRole('group').map((g) => g.getAttribute('aria-label'));
const linksIn = (name) => within(menu().getByRole('group', { name })).getAllByRole('link').map((a) => a.textContent);
const routes = { ...baseRoutes, 'GET /api/costs/reports': { ...page([]), meta: META } };

describe('the side menu', () => {
  it('a viewer has the Monitor group only', async () => {
    renderApp({ role: 'viewer', routes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(groups()).toEqual(['Monitor']);
    expect(linksIn('Monitor')).toEqual(['Overview', 'Reports', 'Alerts']);
  });

  it('an owner also has the money group, with Costs but not Orphaned reports', async () => {
    renderApp({ role: 'owner', routes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(groups()).toEqual(['Monitor', 'Money']);
    expect(linksIn('Money')).toEqual(['Costs']);
  });

  it('an admin has all three groups and every page', async () => {
    renderApp({ role: 'admin', routes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(groups()).toEqual(['Monitor', 'Money', 'Validate']);
    expect(linksIn('Money')).toEqual(['Costs', 'Orphaned reports']);
    expect(linksIn('Validate')).toEqual(['Data quality', 'AI review']);
  });

  it('marks the page you are on, and only that one', async () => {
    renderApp({ role: 'admin', path: '/alerts', routes: { ...routes, 'GET /api/alerts/active': { ...page([]), meta: { last_event_id: 0, by_severity: {} } } } });
    await screen.findByRole('heading', { name: 'Alerts' });
    const current = menu().getAllByRole('link').filter((a) => a.getAttribute('aria-current') === 'page');
    expect(current.map((a) => a.textContent)).toEqual(['Alerts']);
  });

  it('shows who is signed in with their role, an initial that is not read aloud, and a way to sign out', async () => {
    const { container } = renderApp({ role: 'owner', routes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(screen.getByText('user_6@company.com')).toBeInTheDocument();
    expect(screen.getByText('Owner', { selector: '.role' })).toBeInTheDocument();
    expect(container.querySelector('.avatar')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('.avatar')).toHaveTextContent('O');
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('greets the person by first name, and the live status sits beside it', async () => {
    const { container } = renderApp({ role: 'admin', routes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(container.querySelector('.greeting')).toHaveTextContent(/^Good (morning|afternoon|evening), Admin$/);
    expect(container.querySelector('.shell-head .live-pill')).not.toBeNull();
  });

  it('the group labels are only for the eyes: assistive technology reads the group name instead', async () => {
    const { container } = renderApp({ role: 'admin', routes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect([...container.querySelectorAll('.nav-group-label')].every((p) => p.getAttribute('aria-hidden') === 'true')).toBe(true);
  });
});

describe('greeting helpers', () => {
  it('splits the day into morning, afternoon and evening', () => {
    expect([0, 5, 11].map(partOfDay)).toEqual(['morning', 'morning', 'morning']);
    expect([12, 17].map(partOfDay)).toEqual(['afternoon', 'afternoon']);
    expect([18, 23].map(partOfDay)).toEqual(['evening', 'evening']);
  });
  it('uses the name when there is one, and otherwise the start of the email', () => {
    expect(firstName({ name: 'Demo Admin', email: 'admin@demo.local' })).toBe('Demo');
    expect(firstName({ email: 'user_6@company.com' })).toBe('user');
    expect(firstName({ email: 'priya.rao@company.com' })).toBe('priya');
  });
});

describe('the readings switch on a report', () => {
  const obs = (i) => ({
    observation_id: `RPT_1:${i}`, observed_at: new Date(Date.UTC(2026, 8, 1, i)).toISOString(), last_refresh_status: 'SUCCESS', avg_load_time_sec: 10 + i,
    monthly_active_views: 100, concurrent_user_peak: 5, owner_email: null, latency_breach: false,
  });
  const detail = (n) => ({ data: { ...report('RPT_1'), recent_observations: Array.from({ length: n }, (_, i) => obs(n - i)) } });

  it('offers Last 10 or All when there are more than ten readings, and redraws the charts when you choose', async () => {
    renderApp({ role: 'viewer', path: '/reports/RPT_1', routes: { ...baseRoutes, 'GET /api/reports/RPT_1': detail(20) } });
    expect(await screen.findByRole('img', { name: /^Load time over the last 20 readings/ })).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Readings shown' });
    expect(within(group).getByRole('button', { name: 'All 20' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(within(group).getByRole('button', { name: 'Last 10' }));
    expect(await screen.findByRole('img', { name: /^Load time over the last 10 readings; highest 30 seconds/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Monthly active views over the last 10 readings/ })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /^Peak concurrent users over the last 10 readings/ })).toBeInTheDocument();
    await userEvent.click(within(group).getByRole('button', { name: 'All 20' }));
    await waitFor(() => expect(screen.getByRole('img', { name: /^Load time over the last 20 readings/ })).toBeInTheDocument());
  });

  it('keeps the newest readings when it shows the last ten', async () => {
    renderApp({ role: 'viewer', path: '/reports/RPT_1', routes: { ...baseRoutes, 'GET /api/reports/RPT_1': detail(20) } });
    await screen.findByRole('img', { name: /^Load time over the last 20 readings/ });
    await userEvent.click(screen.getByRole('button', { name: 'Last 10' }));
    const chart = await screen.findByRole('img', { name: /^Load time over the last 10 readings/ });
    expect(chart).toHaveAccessibleName(/highest 30 seconds/); // reading 20 is the newest: 10 + 20
    expect(within(chart).getByText('Sep 1, 11:00 UTC')).toBeInTheDocument(); // the first of the last ten is reading 11
  });

  it('draws load time in the brand orange and views and concurrent users in the dark tone', async () => {
    renderApp({ role: 'viewer', path: '/reports/RPT_1', routes: { ...baseRoutes, 'GET /api/reports/RPT_1': detail(12) } });
    expect(await screen.findByRole('img', { name: /^Load time over/ })).toHaveClass('ink-brand');
    expect(screen.getByRole('img', { name: /^Monthly active views/ })).toHaveClass('ink-dark');
    expect(screen.getByRole('img', { name: /^Peak concurrent users/ })).toHaveClass('ink-dark');
  });

  it('has no switch when there is nothing to choose between', async () => {
    renderApp({ role: 'viewer', path: '/reports/RPT_1', routes: { ...baseRoutes, 'GET /api/reports/RPT_1': detail(8) } });
    await screen.findByRole('img', { name: /^Load time over the last 8 readings/ });
    expect(screen.queryByRole('group', { name: 'Readings shown' })).toBeNull();
  });
});
