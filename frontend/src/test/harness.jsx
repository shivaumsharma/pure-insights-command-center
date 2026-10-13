import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from '../App.jsx';
import { AuthProvider } from '../auth/AuthContext.jsx';

export const USERS = {
  admin: { email: 'admin@demo.local', name: 'Admin', role: 'admin' },
  owner: { email: 'user_6@company.com', name: 'Owner', role: 'owner' },
  viewer: { email: 'viewer@demo.local', name: 'Viewer', role: 'viewer' },
};

// A fake WebSocket the tests can drive.
export class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.sent = []; FakeSocket.instances.push(this); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() {}
  open() { this.onopen?.(); }
  receive(msg) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}
export const lastSocket = () => FakeSocket.instances.at(-1);

// routes: { 'GET /api/health': body | (url, init) => ({ status, body }) }. Unlisted routes answer 404 so a stray call is visible.
export function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const path = url.split('?')[0];
    calls.push({ method, url, path, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const handler = routes[`${method} ${path}`];
    if (handler === undefined) return { ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND', message: `no fake for ${method} ${path}` } }) };
    const raw = typeof handler === 'function' ? await handler(url, init) : handler;
    // A handler may return a full response ({ status, body }) or just a body, which means 200.
    const out = raw && typeof raw === 'object' && typeof raw.status === 'number' && 'body' in raw ? raw : { status: 200, body: raw };
    return { ok: out.status < 400, status: out.status, json: async () => out.body };
  };
  fetchImpl.calls = calls;
  fetchImpl.callsTo = (method, path) => calls.filter((c) => c.method === method && c.path === path);
  return fetchImpl;
}

export function renderApp({ path = '/', role = null, routes = {} } = {}) {
  FakeSocket.instances = [];
  sessionStorage.clear();
  if (role) sessionStorage.setItem('pi.session', JSON.stringify({ token: `token-${role}`, user: USERS[role] }));
  const fetchImpl = makeFetch(routes);
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider fetchImpl={fetchImpl}>
        <App WebSocketImpl={FakeSocket} />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { ...utils, fetchImpl };
}

// ---- fixtures shaped like the real API responses ----
export const HEALTH = {
  scope: 'fleet',
  reports: { total: 100, orphaned: 13, by_latest_status: { SUCCESS: 72, FAILED: 15, TIMED_OUT: 8, UNKNOWN: 5 } },
  refresh: { observations: 1976, success: 1322, failed: 379, timed_out: 177, unknown: 98, failure_pct: 28.1 },
  latency: { threshold_sec: 15, breach_observations: 1470, breach_pct: 74.4, at_ceiling_observations: 6 },
};
export const META = { credit_price_usd: 3, price_is_placeholder: true };
export const page = (data, total = data.length, extra = {}) => ({ data, page: { limit: 25, offset: 0, total }, ...extra });

export const report = (id, extra = {}) => ({
  report_id: id, report_name: `Dashboard ${id}`, owner_email: 'user_6@company.com', owner_source: 'observed', is_orphaned: false,
  last_known_owner_email: 'user_6@company.com', orphan_observation_count: 2, last_refresh_status: 'SUCCESS',
  last_observed_at: '2026-09-01T19:00:00.000Z', latest_load_time_sec: 12.3, latest_monthly_active_views: 800,
  observation_count: 20, latency_breach_count: 14, failed_refresh_count: 5, ...extra,
});

export const alert = (id, extra = {}) => ({
  type: 'alert', event_id: id, alert_type: 'LATENCY', lifecycle: 'TRIGGERED', severity: 'high', report_id: 'RPT_201',
  report_name: 'Dashboard RPT_201', observation_id: `RPT_201:${id}`, observed_at: '2026-09-01T03:00:30.000Z',
  suppressed_since_last: 0, value: 41.2, threshold: 15, message: 'RPT_201 load time 41.2 s is over 15 s (high)', ...extra,
});

export const baseRoutes = {
  'GET /api/health': HEALTH,
  'GET /api/alerts/active': { ...page([]), meta: { last_event_id: 0, by_severity: { critical: 0, high: 0, medium: 0, low: 0 } } },
  'GET /api/alerts': { ...page([]), meta: { last_event_id: 0, oldest_event_id: null } },
  'GET /api/reports': page([]),
  'GET /api/alerts/summary': { data: { observations: 100, breaches: { LATENCY: 6, REFRESH_FAILURE: 4 }, emitted: { TRIGGERED: 2, ESCALATED: 1, REPEATED: 1, RESOLVED: 3 }, suppressed: { LATENCY: 4, REFRESH_FAILURE: 2 } } },
};
