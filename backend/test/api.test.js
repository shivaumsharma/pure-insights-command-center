// API tests against a real HTTP server on an ephemeral port, using the real processed data.
// Expected figures come from an independent Python script that reads the processed CSVs directly.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { errorHandler } from '../src/lib/errors.js';
import { createLoginLimiter } from '../src/auth/login-limiter.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUserStore, readUsersFile } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const pw = () => crypto.randomBytes(12).toString('base64url');
const PASSWORDS = { admin: pw(), owner6: pw(), owner2: pw(), viewer: pw() };
const USERS = [
  { email: 'admin@test.local', name: 'A', role: 'admin', password: PASSWORDS.admin },
  { email: 'user_6@company.com', name: 'O6', role: 'owner', password: PASSWORDS.owner6 },
  { email: 'user_2@company.com', name: 'O2', role: 'owner', password: PASSWORDS.owner2 },
  { email: 'viewer@test.local', name: 'V', role: 'viewer', password: PASSWORDS.viewer },
];
const LOGIN = {
  admin: ['admin@test.local', PASSWORDS.admin],
  owner6: ['user_6@company.com', PASSWORDS.owner6],
  owner2: ['user_2@company.com', PASSWORDS.owner2],
  viewer: ['viewer@test.local', PASSWORDS.viewer],
};

const cleanup = [];
after(() => cleanup.forEach((fn) => fn()));
const userStore = await createUserStore(USERS);

async function startApp({ limiter, now } = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-api-'));
  const config = { ...loadConfig({ JWT_SECRET: SECRET }), runtimeDir };
  const tokens = createTokenService({ secret: SECRET, ttl: '1h' });
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir, now });
  const app = createApp({ store, userStore, tokens, config, logger: { error() {} }, limiter });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  cleanup.push(() => { server.close(); fs.rmSync(runtimeDir, { recursive: true, force: true }); });

  const tokenCache = {};
  const call = async (method, url, { token, body, raw } = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined || raw !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const as = async (who) => {
    if (!tokenCache[who]) {
      const [email, password] = LOGIN[who];
      const r = await call('POST', '/api/auth/login', { body: { email, password } });
      assert.equal(r.status, 200, `login as ${who}`);
      tokenCache[who] = r.body.token;
    }
    return tokenCache[who];
  };
  const get = async (who, url) => call('GET', url, { token: await as(who) });
  return { call, as, get, store, runtimeDir, tokens };
}

const shared = await startApp();

// ---------------------------------------------------------------- authentication

test('login: success returns a token and the user without any password material', async () => {
  const r = await shared.call('POST', '/api/auth/login', { body: { email: LOGIN.admin[0], password: LOGIN.admin[1] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user, { email: 'admin@test.local', name: 'A', role: 'admin' });
  assert.ok(r.body.token.split('.').length === 3);
  assert.ok(!/password|hash|scrypt/i.test(r.text));
});

test('login: wrong password and unknown user get the same 401 message (no user enumeration)', async () => {
  const wrong = await shared.call('POST', '/api/auth/login', { body: { email: LOGIN.admin[0], password: 'not-the-password' } });
  const unknown = await shared.call('POST', '/api/auth/login', { body: { email: 'nobody@test.local', password: 'whatever' } });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
});

test('login: malformed input is a 400, not a crash', async () => {
  for (const body of [{}, { email: 'x' }, { email: 'a@b.co', password: 5 }, { email: 'not-an-email', password: 'x' }, { email: 'a@b.co', password: 'x'.repeat(201) }]) {
    const r = await shared.call('POST', '/api/auth/login', { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test('protected routes reject missing, garbage, expired, wrong-secret and alg=none tokens with 401', async () => {
  const expired = jwt.sign({ email: 'admin@test.local', role: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
  const wrongSecret = jwt.sign({ email: 'admin@test.local', role: 'admin' }, 'x'.repeat(40), { algorithm: 'HS256', expiresIn: '1h' });
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const algNone = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ email: 'admin@test.local', role: 'admin', exp: 9999999999 })}.`;
  for (const token of [undefined, 'garbage', expired, wrongSecret, algNone]) {
    const r = await shared.call('GET', '/api/reports', { token });
    assert.equal(r.status, 401, String(token).slice(0, 30));
    assert.equal(r.body.error.code, 'UNAUTHENTICATED');
  }
});

test('a valid signature cannot be edited into a higher role', async () => {
  const viewerToken = await shared.as('viewer');
  const [h, , s] = viewerToken.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ email: 'viewer@test.local', role: 'admin', exp: 9999999999 })).toString('base64url')}.${s}`;
  assert.equal((await shared.call('GET', '/api/orphans', { token: forged })).status, 401);
});

// ---------------------------------------------------------------- authorisation (RBAC)

test('RBAC matrix: admin-only routes return 403 for owner and viewer, 200 for admin', async () => {
  const ctx = await startApp(); // isolated: the PUT/DELETE rows mutate state
  const rows = [
    ['GET', '/api/orphans'], ['GET', '/api/quarantine'], ['GET', '/api/dq-report'], ['GET', '/api/audit'],
    ['GET', '/api/costs/reconciliation'], ['GET', '/api/costs/variance'], ['GET', '/api/costs/aws-mismatch'],
    ['PUT', '/api/reports/RPT_204/owner', { email: 'someone@company.com' }], ['DELETE', '/api/reports/RPT_204/owner'],
  ];
  for (const [method, url, body] of rows) {
    for (const who of ['viewer', 'owner6']) {
      const r = await ctx.call(method, url, { token: await ctx.as(who), body });
      assert.equal(r.status, 403, `${who} ${method} ${url}`);
      assert.equal(r.body.error.code, 'FORBIDDEN');
    }
    const ok = await ctx.call(method, url, { token: await ctx.as('admin'), body });
    assert.equal(ok.status, 200, `admin ${method} ${url}`);
  }
});

test('RBAC matrix: routes open to every signed-in role', async () => {
  for (const who of ['admin', 'owner6', 'viewer']) {
    for (const url of ['/api/health', '/api/reports', '/api/auth/me']) {
      assert.equal((await shared.get(who, url)).status, 200, `${who} ${url}`);
    }
  }
});

test('cost routes: viewer 403; owner and admin 200', async () => {
  assert.equal((await shared.get('viewer', '/api/costs/reports')).status, 403);
  assert.equal((await shared.get('owner6', '/api/costs/reports')).status, 200);
  assert.equal((await shared.get('admin', '/api/costs/reports')).status, 200);
});

test('viewer never receives cost data, in lists or in detail', async () => {
  const list = await shared.get('viewer', '/api/reports?limit=200');
  assert.ok(list.body.data.length > 0);
  assert.ok(list.body.data.every((r) => !('cost' in r)));
  assert.ok(!('meta' in list.body));
  const detail = await shared.get('viewer', '/api/reports/RPT_200');
  assert.equal(detail.status, 200);
  assert.ok(!('cost' in detail.body.data));
  assert.ok(!/total_cost|cost_per_view|attributed_credits/.test(list.text + detail.text));
  assert.equal((await shared.get('viewer', '/api/reports?sort=cost')).status, 400);
});

test('owner scoping: sees only reports they currently own, health is scoped, other reports are 404', async () => {
  const OWN6 = ['RPT_206', 'RPT_210', 'RPT_216', 'RPT_217', 'RPT_236', 'RPT_249', 'RPT_252', 'RPT_291', 'RPT_299'];
  const OWN2 = ['RPT_200', 'RPT_219', 'RPT_255', 'RPT_294'];
  const l6 = await shared.get('owner6', '/api/reports?limit=200');
  assert.deepEqual(l6.body.data.map((r) => r.report_id), OWN6);
  assert.equal(l6.body.page.total, 9);
  const l2 = await shared.get('owner2', '/api/reports?limit=200');
  assert.deepEqual(l2.body.data.map((r) => r.report_id), OWN2);

  const h6 = (await shared.get('owner6', '/api/health')).body;
  assert.equal(h6.scope, 'owned');
  assert.equal(h6.reports.total, 9);

  assert.equal((await shared.get('owner6', '/api/reports/RPT_200')).status, 404); // belongs to user_2
  assert.equal((await shared.get('owner2', '/api/reports/RPT_200')).status, 200);
  const c6 = (await shared.get('owner6', '/api/costs/reports?limit=200')).body;
  assert.deepEqual(c6.data.map((r) => r.report_id).sort(), OWN6);
  assert.ok(c6.data.every((r) => r.owner_email === 'user_6@company.com'));
});

// ---------------------------------------------------------------- correct numbers

test('fleet health matches the independent figures', async () => {
  const h = (await shared.get('admin', '/api/health')).body;
  assert.equal(h.scope, 'fleet');
  assert.equal(h.reports.total, 100);
  assert.equal(h.reports.orphaned, 13);
  assert.deepEqual(h.reports.by_latest_status, { SUCCESS: 72, FAILED: 15, TIMED_OUT: 8, UNKNOWN: 5 });
  assert.deepEqual(h.refresh, { observations: 1976, success: 1322, failed: 379, timed_out: 177, unknown: 98, failure_pct: 28.1 });
  assert.deepEqual(h.latency, { threshold_sec: 15, breach_observations: 1470, breach_pct: 74.4, at_ceiling_observations: 6 });
});

test('reports list: filters, search and sorting', async () => {
  const q = async (qs) => (await shared.get('admin', `/api/reports?${qs}`)).body;
  assert.equal((await q('limit=200')).page.total, 100);
  assert.equal((await q('status=FAILED')).page.total, 15);
  assert.equal((await q('orphaned=true')).page.total, 13);
  assert.equal((await q('orphaned=false')).page.total, 87);
  assert.equal((await q('q=rpt_29')).page.total, 10);
  assert.deepEqual((await q('sort=failures&limit=2')).data.map((r) => r.report_id), ['RPT_203', 'RPT_275']); // tied at 10; id ascending
  assert.equal((await q('sort=latency&limit=1')).data[0].report_id, 'RPT_201');
  assert.equal((await q('sort=cost&limit=1')).data[0].report_id, 'RPT_299');
  assert.deepEqual((await q('sort=failures&order=asc&limit=1')).data.length, 1);
});

test('report detail has recent observations, newest first, capped at 20', async () => {
  const d = (await shared.get('admin', '/api/reports/RPT_203')).body.data;
  assert.equal(d.report_id, 'RPT_203');
  assert.equal(d.recent_observations.length, d.observation_count > 20 ? 20 : d.observation_count);
  const times = d.recent_observations.map((o) => o.observed_at);
  assert.deepEqual(times, [...times].sort().reverse());
  assert.equal(d.failed_refresh_count, 10);
});

test('orphans: 13 reports, costliest first, with the placeholder-price warning', async () => {
  const r = (await shared.get('admin', '/api/orphans')).body;
  assert.equal(r.page.total, 13);
  assert.deepEqual(r.data.map((x) => x.report_id).sort(),
    ['RPT_204', 'RPT_220', 'RPT_228', 'RPT_232', 'RPT_234', 'RPT_239', 'RPT_261', 'RPT_265', 'RPT_269', 'RPT_270', 'RPT_283', 'RPT_292', 'RPT_298']);
  assert.equal(r.data[0].report_id, 'RPT_298');
  assert.ok(Math.abs(r.meta.orphaned_spend_usd - 521801.03) < 0.1);
  assert.equal(r.meta.price_is_placeholder, true);
  assert.ok(r.data.every((x) => x.last_known_owner_email));
});

test('quarantine and DQ report', async () => {
  const q = (await shared.get('admin', '/api/quarantine?limit=200')).body;
  assert.equal(q.page.total, 24);
  assert.ok(q.data.every((x) => x.reason_codes === 'NEGATIVE_CREDITS'));
  assert.equal((await shared.get('admin', '/api/quarantine?reason=negative')).body.page.total, 24);
  assert.equal((await shared.get('admin', '/api/quarantine?reason=nomatch')).body.page.total, 0);
  const dq = (await shared.get('admin', '/api/dq-report')).body.data;
  assert.equal(dq.rows.quarantined, 24);
});

test('cost endpoints serve the SQL suite results and flag the placeholder price', async () => {
  const rec = (await shared.get('admin', '/api/costs/reconciliation')).body;
  assert.deepEqual(rec.summary, { pass: 6, fail: 1, info: 1 });
  assert.equal(rec.data.find((c) => c.check_id === 'R8').actual_value, 64);
  assert.equal(rec.meta.price_is_placeholder, true);
  const costs = (await shared.get('admin', '/api/costs/reports?limit=3')).body;
  assert.deepEqual(costs.data.map((r) => [r.report_id, r.total_cost_usd]), [['RPT_299', 71948.79], ['RPT_260', 59056.55], ['RPT_254', 57642.2]]);
  assert.equal(typeof costs.data[0].is_orphaned, 'boolean');
  assert.equal((await shared.get('admin', '/api/costs/variance?status=OUTSIDE_TOLERANCE')).body.page.total, 64);
  const aws = (await shared.get('admin', '/api/costs/aws-mismatch?limit=1')).body;
  assert.equal(aws.page.total, 625);
  assert.equal((await shared.get('admin', '/api/costs/aws-mismatch?type=ZERO_VIEWS_WITH_COST')).body.page.total, 4);
});

// ---------------------------------------------------------------- owner reassignment

test('assigning an owner updates orphans, scoping, costs and the audit trail, and survives a restart', async () => {
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 10, 12, 0, tick++));
  const ctx = await startApp({ now });
  const admin = await ctx.as('admin');

  const before = (await ctx.get('admin', '/api/orphans')).body;
  assert.equal(before.page.total, 13);
  const put = await ctx.call('PUT', '/api/reports/RPT_204/owner', { token: admin, body: { email: ' User_6@Company.com ' } });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.owner_email, 'user_6@company.com');
  assert.equal(put.body.data.owner_source, 'assigned');
  assert.equal(put.body.data.is_orphaned, false);

  assert.equal((await ctx.get('admin', '/api/orphans')).body.page.total, 12);
  assert.equal((await ctx.get('admin', '/api/health')).body.reports.orphaned, 12);
  const mine = (await ctx.get('owner6', '/api/reports?limit=200')).body;
  assert.equal(mine.page.total, 10);
  assert.ok(mine.data.some((r) => r.report_id === 'RPT_204'));
  assert.equal((await ctx.get('owner6', '/api/costs/reports?limit=200')).body.page.total, 10);

  const audit = (await ctx.get('admin', '/api/audit')).body.data[0];
  assert.deepEqual([audit.action, audit.actor, audit.report_id, audit.from, audit.to], ['ASSIGN', 'admin@test.local', 'RPT_204', null, 'user_6@company.com']);
  assert.equal(audit.at, '2026-10-10T12:00:01.000Z');

  // A second store reading the same runtime directory sees the assignment (persistence).
  const reloaded = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: ctx.runtimeDir });
  assert.equal(reloaded.summary('RPT_204').owner_email, 'user_6@company.com');

  const del = await ctx.call('DELETE', '/api/reports/RPT_204/owner', { token: admin });
  assert.equal(del.body.data.is_orphaned, true);
  assert.equal((await ctx.get('admin', '/api/orphans')).body.page.total, 13);
});

test('assignment validation: bad email 400, unknown report 404, bad id 400, no body 400', async () => {
  const token = await shared.as('admin');
  const put = (url, body, raw) => shared.call('PUT', url, { token, body, raw });
  assert.equal((await put('/api/reports/RPT_204/owner', { email: 'nope' })).status, 400);
  assert.equal((await put('/api/reports/RPT_204/owner', { email: 5 })).status, 400);
  assert.equal((await put('/api/reports/RPT_204/owner', {})).status, 400);
  assert.equal((await put('/api/reports/RPT_204/owner')).status, 400);
  assert.equal((await put('/api/reports/RPT_999/owner', { email: 'a@b.co' })).status, 404);
  assert.equal((await put('/api/reports/bad%20id/owner', { email: 'a@b.co' })).status, 400);
  assert.equal((await shared.get('admin', '/api/orphans')).body.page.total, 13); // nothing changed
});

// ---------------------------------------------------------------- input handling and hygiene

test('query validation: bad limit, offset, sort, status, boolean and repeated params are 400', async () => {
  for (const qs of ['limit=0', 'limit=201', 'limit=abc', 'offset=-1', 'sort=bogus', 'status=nope', 'orphaned=maybe', 'limit=1&limit=2', `q=${'x'.repeat(101)}`]) {
    const r = await shared.get('admin', `/api/reports?${qs}`);
    assert.equal(r.status, 400, qs);
    assert.equal(r.body.error.code, 'BAD_REQUEST');
  }
  const page = await shared.get('admin', '/api/reports?limit=5&offset=98');
  assert.equal(page.body.data.length, 2);
  assert.equal(page.body.page.total, 100);
});

test('hygiene: JSON errors for bad bodies and unknown routes, oversized body, no banner, no caching', async () => {
  const malformed = await shared.call('POST', '/api/auth/login', { raw: '{not json' });
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'BAD_REQUEST');

  const big = await shared.call('POST', '/api/auth/login', { raw: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(20_000) }) });
  assert.equal(big.status, 413);

  const unknown = await shared.get('admin', '/api/does-not-exist');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, 'NOT_FOUND');
  assert.equal((await shared.call('GET', '/nope')).status, 404);

  const r = await shared.get('admin', '/api/health');
  assert.equal(r.headers.get('x-powered-by'), null);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await shared.call('GET', '/healthz')).body.status, 'ok');
});

test('unexpected errors return a generic 500 and never leak the message or stack', () => {
  let logged = null;
  const handler = errorHandler({ error: (...a) => { logged = a; } });
  const res = { status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  handler(new Error('secret connection string at C:\\internal'), {}, res, () => {});
  assert.equal(res.code, 500);
  assert.deepEqual(res.body, { error: { code: 'INTERNAL', message: 'Something went wrong on our side' } });
  assert.ok(logged, 'the real error is still logged server-side');
});

test('login throttling: 5 failures block even the right password; other users unaffected; window expiry and success reset', async () => {
  let t = 1_000_000;
  const limiter = createLoginLimiter({ maxFailures: 5, windowMs: 15 * 60 * 1000, now: () => t });
  const ctx = await startApp({ limiter });
  const login = (email, password) => ctx.call('POST', '/api/auth/login', { body: { email, password } });
  const [adminEmail, adminPw] = LOGIN.admin;

  for (let i = 0; i < 5; i++) assert.equal((await login(adminEmail, 'wrong')).status, 401);
  const blocked = await login(adminEmail, adminPw);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.body.error.code, 'TOO_MANY_ATTEMPTS');
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);

  assert.equal((await login(...LOGIN.viewer)).status, 200); // a different account is not affected

  t += 15 * 60 * 1000 + 1; // window passes
  assert.equal((await login(adminEmail, adminPw)).status, 200);

  for (let i = 0; i < 4; i++) await login(LOGIN.owner2[0], 'wrong');
  assert.equal((await login(...LOGIN.owner2)).status, 200); // success clears the count
  for (let i = 0; i < 4; i++) assert.equal((await login(LOGIN.owner2[0], 'wrong')).status, 401);
});

test('login throttling is on by default: the limiter built from config blocks after 5 failures', async () => {
  const ctx = await startApp(); // no limiter passed in -> createApp builds one from config
  const [email, password] = LOGIN.owner2;
  for (let i = 0; i < 5; i++) assert.equal((await ctx.call('POST', '/api/auth/login', { body: { email, password: 'wrong' } })).status, 401);
  assert.equal((await ctx.call('POST', '/api/auth/login', { body: { email, password } })).status, 429);
});

test('demo users file: valid, all three roles present, owner demo accounts exist in the data, passwords are not trivial', () => {
  const users = readUsersFile(path.resolve(import.meta.dirname, '../config/demo-users.json'));
  assert.deepEqual([...new Set(users.map((u) => u.role))].sort(), ['admin', 'owner', 'viewer']);
  assert.equal(new Set(users.map((u) => u.email)).size, users.length);
  for (const u of users) assert.ok(u.password.length >= 12, `${u.email} password too short`);
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-demo-')) });
  const owners = new Set(store.summaries().map((s) => s.owner_email));
  for (const u of users.filter((x) => x.role === 'owner')) assert.ok(owners.has(u.email), `${u.email} owns no reports`);
});
