// WebSocket hub and alert REST routes, tested over real sockets on an ephemeral port.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import jwt from 'jsonwebtoken';
import WebSocket from 'ws';
import { createAlertService } from '../src/alerts/service.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUserStore } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { createHub } from '../src/realtime/hub.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const EPOCH = Date.UTC(2026, 8, 1);
const at = (h) => new Date(EPOCH + h * 3_600_000).toISOString();
// Report ownership in the real data: user_2 owns RPT_200/219/255/294, user_6 owns RPT_206/210/216/217/..., RPT_204 is orphaned.
const breach = (report, hour = 0, load = 20) => ({
  observation_id: `${report}@${hour}`, report_id: report, report_name: report, observed_at: at(hour),
  avg_load_time_sec: load, last_refresh_status: 'SUCCESS',
});

const cleanup = [];
after(() => cleanup.forEach((fn) => fn()));
const tokens = createTokenService({ secret: SECRET, ttl: '1h' });
const userStore = await createUserStore([{ email: 'x@x.co', name: 'x', role: 'viewer', password: 'unused-password-1' }]);
const tokenFor = (email, role) => tokens.sign({ email, role });
const T = {
  admin: () => tokenFor('admin@test.local', 'admin'),
  viewer: () => tokenFor('viewer@test.local', 'viewer'),
  owner2: () => tokenFor('user_2@company.com', 'owner'),
  owner6: () => tokenFor('user_6@company.com', 'owner'),
};

async function start({ historyCapacity = 2000, cfg = {} } = {}) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rt-'));
  const config = { ...loadConfig({ JWT_SECRET: SECRET }), runtimeDir, wsAuthTimeoutMs: 400, ...cfg };
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir });
  const alerts = createAlertService({ store, historyCapacity });
  const app = createApp({ store, userStore, tokens, config, alerts, logger: { error() {} } });
  const server = http.createServer(app);
  const hub = createHub({ server, tokens, alerts, config, logger: { error() {} } });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  cleanup.push(() => { hub.close(); server.close(); fs.rmSync(runtimeDir, { recursive: true, force: true }); });
  return {
    store, alerts, hub, server, config,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    http: async (token, url) => {
      const res = await fetch(`http://127.0.0.1:${port}${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: res.status, body: await res.json() };
    },
  };
}

// Resolves with the HTTP status if the handshake is refused, or 'connected' if it succeeds, so a missing rejection fails a test
// instead of hanging it.
function handshake(url, options) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, options);
    const timer = setTimeout(() => { ws.terminate(); resolve('timeout'); }, 2000);
    ws.on('unexpected-response', (req, res) => { clearTimeout(timer); resolve(res.statusCode); });
    ws.on('open', () => { clearTimeout(timer); ws.close(); resolve('connected'); });
    ws.on('error', () => {});
  });
}

// A small client that records everything it receives.
function client(url, options) {
  const ws = new WebSocket(url, options);
  const messages = [];
  let closed = null;
  ws.on('message', (d) => messages.push(JSON.parse(d.toString())));
  ws.on('close', (code, reason) => { closed = { code, reason: reason.toString() }; });
  ws.on('error', () => {});
  const wait = async (check, what, ms = 2500) => {
    const start = Date.now();
    for (;;) {
      const r = check();
      if (r) return r;
      if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}; got ${JSON.stringify(messages)} closed=${JSON.stringify(closed)}`);
      await new Promise((res) => setTimeout(res, 8));
    }
  };
  const c = {
    ws, messages,
    opened: () => wait(() => ws.readyState === WebSocket.OPEN, 'open'),
    send: (obj) => ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)),
    waitFor: (pred, what = 'a message') => wait(() => messages.find(pred), what),
    waitClosed: () => wait(() => closed, 'close'),
    get closed() { return closed; },
    alerts: () => messages.filter((m) => m.type === 'alert'),
    // Barrier: once the pong for this ping arrives, every message the server sent earlier has arrived too.
    async sync() {
      const before = messages.filter((m) => m.type === 'pong').length;
      c.send({ type: 'ping' });
      await wait(() => messages.filter((m) => m.type === 'pong').length > before, 'pong');
    },
    async login(token, lastEventId) {
      await c.opened();
      c.send(lastEventId === undefined ? { type: 'auth', token } : { type: 'auth', token, last_event_id: lastEventId });
      return c.waitFor((m) => m.type === 'ready' || m.type === 'error', 'ready');
    },
  };
  cleanup.push(() => ws.terminate());
  return c;
}

// ------------------------------------------------------------------ connecting and authenticating

test('a valid token gets "ready" with the user and the current event id', async () => {
  const rt = await start();
  rt.alerts.ingest(breach('RPT_200'));
  const c = client(rt.wsUrl);
  const ready = await c.login(T.admin());
  assert.equal(ready.type, 'ready');
  assert.deepEqual(ready.user, { email: 'admin@test.local', role: 'admin' });
  assert.equal(ready.last_event_id, 1);
  assert.equal(ready.resumed, false);
  assert.equal(c.alerts().length, 0); // no history replay unless asked
});

test('no auth message in time closes with 4401; a token in the URL is ignored', async () => {
  const rt = await start();
  const silent = client(rt.wsUrl);
  await silent.opened();
  assert.equal((await silent.waitClosed()).code, 4401);

  const viaUrl = client(`${rt.wsUrl}?token=${T.admin()}`);
  await viaUrl.opened();
  assert.equal((await viaUrl.waitClosed()).code, 4401); // still needs the auth message
});

test('bad credentials: garbage, expired, wrong-secret tokens and speaking before auth all close with 4401', async () => {
  const rt = await start();
  const expired = jwt.sign({ email: 'admin@test.local', role: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: -10 });
  const forged = jwt.sign({ email: 'admin@test.local', role: 'admin' }, 'z'.repeat(40), { algorithm: 'HS256' });
  for (const token of ['garbage', expired, forged, 12345, null]) {
    const c = client(rt.wsUrl);
    const r = await c.login(token);
    assert.equal(r.type, 'error');
    assert.equal(r.code, 'UNAUTHENTICATED');
    assert.equal((await c.waitClosed()).code, 4401, String(token).slice(0, 20));
  }
  const early = client(rt.wsUrl);
  await early.opened();
  early.send({ type: 'ping' });
  assert.equal((await early.waitClosed()).code, 4401);
});

test('origin check: a foreign Origin is refused with 403; the allowed dev origin and non-browser clients connect', async () => {
  const rt = await start();
  assert.equal(await handshake(rt.wsUrl, { headers: { Origin: 'https://evil.example' } }), 403);

  const dev = client(rt.wsUrl, { headers: { Origin: 'http://localhost:5173' } });
  assert.equal((await dev.login(T.admin())).type, 'ready');
  const noOrigin = client(rt.wsUrl);
  assert.equal((await noOrigin.login(T.admin())).type, 'ready');
});

test('same-origin pages are allowed (the UI is served by this server); look-alike hosts, other ports and "null" are not', async () => {
  const rt = await start();
  const port = new URL(rt.wsUrl).port;
  assert.equal(await handshake(rt.wsUrl, { headers: { Origin: `http://127.0.0.1:${port}` } }), 'connected');
  for (const origin of [`http://127.0.0.1.evil.example:${port}`, `http://127.0.0.1:${Number(port) + 1}`, 'null', `https://127.0.0.1:${port}.evil.example`, 'not a url']) {
    assert.equal(await handshake(rt.wsUrl, { headers: { Origin: origin } }), 403, origin);
  }
});

test('only /ws accepts upgrades', async () => {
  const rt = await start();
  assert.equal(await handshake(rt.wsUrl.replace('/ws', '/elsewhere')), 404);
});

// ------------------------------------------------------------------ live delivery and role filtering

test('live alerts are filtered by role: admin and viewer get all, each owner only their own reports', async () => {
  const rt = await start();
  const [admin, viewer, o2, o6] = [client(rt.wsUrl), client(rt.wsUrl), client(rt.wsUrl), client(rt.wsUrl)];
  await Promise.all([admin.login(T.admin()), viewer.login(T.viewer()), o2.login(T.owner2()), o6.login(T.owner6())]);

  rt.alerts.ingest(breach('RPT_200')); // user_2's report
  rt.alerts.ingest(breach('RPT_206')); // user_6's report
  rt.alerts.ingest(breach('RPT_204')); // orphaned: nobody owns it
  await Promise.all([admin, viewer, o2, o6].map((c) => c.sync()));

  const ids = (c) => c.alerts().map((a) => a.report_id);
  assert.deepEqual(ids(admin), ['RPT_200', 'RPT_206', 'RPT_204']);
  assert.deepEqual(ids(viewer), ['RPT_200', 'RPT_206', 'RPT_204']);
  assert.deepEqual(ids(o2), ['RPT_200']);
  assert.deepEqual(ids(o6), ['RPT_206']);
  assert.deepEqual(admin.alerts().map((a) => a.event_id), [1, 2, 3]);
});

test('wire format: the envelope is {type:"alert"} and the alert kind lives in alert_type (they must not collide)', async () => {
  const rt = await start();
  const c = client(rt.wsUrl);
  await c.login(T.admin());
  rt.alerts.ingest({ ...breach('RPT_200'), last_refresh_status: 'FAILED' }); // a latency alert and a refresh-failure alert
  await c.sync();
  assert.deepEqual(c.messages.filter((m) => m.type === 'alert').map((m) => m.alert_type).sort(), ['LATENCY', 'REFRESH_FAILURE']);
  assert.ok(c.messages.every((m) => ['ready', 'alert', 'pong'].includes(m.type)), JSON.stringify(c.messages.map((m) => m.type)));
  const a = c.alerts()[0];
  for (const field of ['event_id', 'alert_type', 'lifecycle', 'severity', 'report_id', 'observed_at', 'message', 'suppressed_since_last']) {
    assert.ok(field in a, `alert is missing ${field}`);
  }
});

test('reassigning a report re-routes its next alerts to the new owner immediately', async () => {
  const rt = await start();
  const [o2, o6] = [client(rt.wsUrl), client(rt.wsUrl)];
  await Promise.all([o2.login(T.owner2()), o6.login(T.owner6())]);
  rt.alerts.ingest(breach('RPT_200', 0));
  rt.store.assign('RPT_200', 'user_6@company.com', 'admin@test.local');
  rt.alerts.ingest(breach('RPT_200', 1, 50)); // worse -> escalates -> a new alert
  await Promise.all([o2.sync(), o6.sync()]);
  assert.deepEqual(o2.alerts().map((a) => a.event_id), [1]);
  assert.deepEqual(o6.alerts().map((a) => a.event_id), [2]);
});

// ------------------------------------------------------------------ reconnecting

test('reconnect with last_event_id delivers exactly the missed alerts, in order, once, then continues live', async () => {
  const rt = await start();
  const first = client(rt.wsUrl);
  await first.login(T.admin());
  for (const r of ['RPT_200', 'RPT_206', 'RPT_219']) rt.alerts.ingest(breach(r)); // ids 1-3
  await first.waitFor((m) => m.type === 'alert' && m.event_id === 2, 'event 2');
  first.ws.terminate(); // connection drops after the client saw 1 and 2 (it may or may not have seen 3)

  for (const r of ['RPT_210', 'RPT_216']) rt.alerts.ingest(breach(r)); // ids 4-5 while disconnected

  const again = client(rt.wsUrl);
  const ready = await again.login(T.admin(), 2);
  assert.equal(ready.resumed, true);
  rt.alerts.ingest(breach('RPT_217')); // id 6, live after reconnect
  await again.waitFor((m) => m.type === 'alert' && m.event_id === 6, 'live event 6');
  assert.deepEqual(again.alerts().map((a) => a.event_id), [3, 4, 5, 6]);
  assert.ok(!again.messages.some((m) => m.type === 'gap'));
});

test('reconnect replay is role-filtered too', async () => {
  const rt = await start();
  for (const r of ['RPT_200', 'RPT_206', 'RPT_219', 'RPT_210', 'RPT_255']) rt.alerts.ingest(breach(r)); // ids 1-5
  const o2 = client(rt.wsUrl);
  await o2.login(T.owner2(), 1);
  await o2.sync();
  assert.deepEqual(o2.alerts().map((a) => [a.event_id, a.report_id]), [[3, 'RPT_219'], [5, 'RPT_255']]);
});

test('a client that was away too long gets a "gap" notice, then what remains', async () => {
  const rt = await start({ historyCapacity: 3 });
  for (const r of ['RPT_200', 'RPT_206', 'RPT_219', 'RPT_210', 'RPT_216', 'RPT_217']) rt.alerts.ingest(breach(r)); // ids 1-6, ring keeps 4-6
  const c = client(rt.wsUrl);
  await c.login(T.admin(), 1);
  await c.sync();
  const gap = c.messages.find((m) => m.type === 'gap');
  assert.equal(gap.oldest_event_id, 4);
  assert.equal(gap.last_event_id, 6);
  assert.deepEqual(c.alerts().map((a) => a.event_id), [4, 5, 6]);

  const exact = client(rt.wsUrl); // last seen 3, ring starts at 4: nothing lost
  await exact.login(T.admin(), 3);
  await exact.sync();
  assert.ok(!exact.messages.some((m) => m.type === 'gap'));
  assert.deepEqual(exact.alerts().map((a) => a.event_id), [4, 5, 6]);
});

test('ready carries a stream id that is stable within one server run and different between runs', async () => {
  const a = await start();
  const b = await start();
  const ids = [];
  for (const rt of [a, a, b]) {
    const c = client(rt.wsUrl);
    ids.push((await c.login(T.admin())).stream_id);
  }
  assert.match(ids[0], /^[a-z0-9]{8}$/);
  assert.equal(ids[0], ids[1]);
  assert.notEqual(ids[0], ids[2]);
});

test('resuming with the stream id of an earlier server run reports a restart and replays nothing, even if the numbers overlap', async () => {
  const rt = await start();
  for (const r of ['RPT_200', 'RPT_206', 'RPT_219']) rt.alerts.ingest(breach(r)); // this run's ids 1-3
  const c = client(rt.wsUrl);
  await c.opened();
  c.send({ type: 'auth', token: T.admin(), last_event_id: 1, stream_id: 'previousrun' }); // would replay 2 and 3 if ids were trusted
  await c.waitFor((m) => m.type === 'ready', 'ready');
  const gap = await c.waitFor((m) => m.type === 'gap', 'gap');
  assert.equal(gap.reason, 'restarted');
  assert.equal(gap.last_event_id, 3);
  await c.sync();
  assert.equal(c.alerts().length, 0, 'ids from a different run must not be replayed');

  rt.alerts.ingest(breach('RPT_210')); // live alerts still arrive
  await c.waitFor((m) => m.type === 'alert' && m.event_id === 4, 'live alert 4');
});

test('resuming with this run\'s own stream id replays normally; a client ahead of the server is told it restarted', async () => {
  const rt = await start();
  for (const r of ['RPT_200', 'RPT_206', 'RPT_219']) rt.alerts.ingest(breach(r));
  const same = client(rt.wsUrl);
  await same.opened();
  same.send({ type: 'auth', token: T.admin(), last_event_id: 1, stream_id: rt.alerts.streamId() });
  await same.waitFor((m) => m.type === 'ready', 'ready');
  await same.sync();
  assert.deepEqual(same.alerts().map((a) => a.event_id), [2, 3]);
  assert.ok(!same.messages.some((m) => m.type === 'gap'));

  const ahead = client(rt.wsUrl); // no stream id (an older client), but claims to have seen event 99 of a 3-event stream
  await ahead.login(T.admin(), 99);
  const gap = await ahead.waitFor((m) => m.type === 'gap', 'gap');
  assert.equal(gap.reason, 'restarted');
  assert.equal(ahead.alerts().length, 0);
});

test('stream_id must be a short lowercase token', async () => {
  const rt = await start();
  for (const bad of [5, 'UPPER', 'has space', 'x'.repeat(33), '']) {
    const c = client(rt.wsUrl);
    await c.opened();
    c.send({ type: 'auth', token: T.admin(), last_event_id: 0, stream_id: bad });
    assert.equal((await c.waitFor((m) => m.type === 'error', 'error')).code, 'BAD_REQUEST');
    assert.equal((await c.waitClosed()).code, 1008);
  }
});

test('last_event_id must be a whole number', async () => {
  const rt = await start();
  for (const bad of [-1, 1.5, 'x', null]) {
    const c = client(rt.wsUrl);
    await c.opened();
    c.send({ type: 'auth', token: T.admin(), last_event_id: bad });
    const err = await c.waitFor((m) => m.type === 'error', 'error');
    assert.equal(err.code, 'BAD_REQUEST');
    assert.equal((await c.waitClosed()).code, 1008);
  }
});

// ------------------------------------------------------------------ protecting the server

test('abuse: binary frames, repeated junk, and oversized messages are closed', async () => {
  const rt = await start();
  const bin = client(rt.wsUrl);
  await bin.opened();
  bin.ws.send(Buffer.from([1, 2, 3]));
  assert.equal((await bin.waitClosed()).code, 1003);

  const junk = client(rt.wsUrl);
  await junk.login(T.admin());
  for (let i = 0; i < 7; i++) junk.send('not json');
  assert.equal((await junk.waitClosed()).code, 1008);

  const big = client(rt.wsUrl);
  await big.login(T.admin());
  big.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(5000) }));
  assert.equal((await big.waitClosed()).code, 1009);
});

test('connection caps: a per-user limit that frees up when a socket closes', async () => {
  const rt = await start({ cfg: { wsMaxPerUser: 2 } });
  const a = client(rt.wsUrl);
  const b = client(rt.wsUrl);
  await a.login(T.owner2());
  await b.login(T.owner2());
  const c = client(rt.wsUrl);
  const refused = await c.login(T.owner2());
  assert.equal(refused.code, 'TOO_MANY_CONNECTIONS');
  assert.equal((await c.waitClosed()).code, 4429);

  assert.equal((await client(rt.wsUrl).login(T.admin())).type, 'ready'); // other users unaffected
  a.ws.close();
  await a.waitClosed();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await client(rt.wsUrl).login(T.owner2())).type, 'ready');
});

test('the socket is closed when the token expires', async () => {
  const rt = await start();
  const shortLived = jwt.sign({ email: 'admin@test.local', role: 'admin' }, SECRET, { algorithm: 'HS256', expiresIn: 1 });
  const c = client(rt.wsUrl);
  assert.equal((await c.login(shortLived)).type, 'ready');
  const closed = await c.waitClosed();
  assert.equal(closed.code, 4401);
  assert.ok(c.messages.some((m) => m.type === 'error' && m.code === 'TOKEN_EXPIRED'));
});

test('heartbeat: a client that stops answering pings is dropped; a healthy one stays', async () => {
  const rt = await start({ cfg: { wsHeartbeatMs: 80 } });
  const healthy = client(rt.wsUrl);
  const deaf = client(rt.wsUrl, { autoPong: false });
  await Promise.all([healthy.login(T.admin()), deaf.login(T.viewer())]);
  await deaf.waitClosed();
  await new Promise((r) => setTimeout(r, 250)); // several more heartbeat rounds
  assert.equal(healthy.closed, null);
  assert.equal(healthy.ws.readyState, WebSocket.OPEN);
});

test('closing cleans up: connection count returns to zero and the server shuts down with 1001', async () => {
  const rt = await start();
  const a = client(rt.wsUrl);
  const b = client(rt.wsUrl);
  await Promise.all([a.login(T.admin()), b.login(T.viewer())]);
  assert.equal(rt.hub.connectionCount(), 2);
  a.ws.close();
  await a.waitClosed();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(rt.hub.connectionCount(), 1);
  rt.hub.close();
  assert.equal((await b.waitClosed()).code, 1001);
});

// ------------------------------------------------------------------ REST: alert history

test('GET /api/alerts: role-scoped, filterable, newest first, with the event-id range for gap recovery', async () => {
  const rt = await start();
  rt.alerts.ingest(breach('RPT_200', 0, 20)); // 1 low (user_2)
  rt.alerts.ingest(breach('RPT_206', 0, 40)); // 2 high (user_6)
  rt.alerts.ingest(breach('RPT_200', 1, 50)); // 3 escalates to high (user_2)

  const all = await rt.http(T.admin(), '/api/alerts');
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.data.map((a) => a.event_id), [3, 2, 1]);
  assert.deepEqual(all.body.meta, { last_event_id: 3, oldest_event_id: 1 });

  assert.equal((await rt.http(T.viewer(), '/api/alerts')).body.page.total, 3);
  assert.deepEqual((await rt.http(T.owner2(), '/api/alerts')).body.data.map((a) => a.event_id), [3, 1]);
  assert.deepEqual((await rt.http(T.owner6(), '/api/alerts')).body.data.map((a) => a.event_id), [2]);

  assert.equal((await rt.http(T.admin(), '/api/alerts?severity=high')).body.page.total, 2);
  assert.equal((await rt.http(T.admin(), '/api/alerts?lifecycle=ESCALATED')).body.page.total, 1);
  assert.equal((await rt.http(T.admin(), '/api/alerts?report_id=RPT_206')).body.page.total, 1);
  assert.equal((await rt.http(T.admin(), '/api/alerts?limit=1&offset=1')).body.data[0].event_id, 2);
});

test('GET /api/alerts validation and authentication', async () => {
  const rt = await start();
  assert.equal((await rt.http(null, '/api/alerts')).status, 401);
  for (const qs of ['severity=nope', 'alert_type=x', 'lifecycle=y', 'report_id=bad%20id', 'limit=0']) {
    assert.equal((await rt.http(T.admin(), `/api/alerts?${qs}`)).status, 400, qs);
  }
});

test('GET /api/alerts/active lists open conditions, worst first, scoped by role', async () => {
  const rt = await start();
  rt.alerts.ingest(breach('RPT_200', 0, 20)); // low, user_2
  rt.alerts.ingest(breach('RPT_206', 0, 55)); // critical, user_6
  rt.alerts.ingest(breach('RPT_204', 0, 30)); // medium, orphan
  const admin = (await rt.http(T.admin(), '/api/alerts/active')).body.data;
  assert.deepEqual(admin.map((a) => [a.report_id, a.severity]), [['RPT_206', 'critical'], ['RPT_204', 'medium'], ['RPT_200', 'low']]);
  assert.deepEqual((await rt.http(T.owner2(), '/api/alerts/active')).body.data.map((a) => a.report_id), ['RPT_200']);
  // Severity counts cover everything the caller may see, even when the page is smaller than the list.
  const paged = (await rt.http(T.admin(), '/api/alerts/active?limit=1')).body;
  assert.equal(paged.data.length, 1);
  assert.deepEqual(paged.meta.by_severity, { critical: 1, high: 0, medium: 1, low: 1 });
  assert.deepEqual((await rt.http(T.owner2(), '/api/alerts/active')).body.meta.by_severity, { critical: 0, high: 0, medium: 0, low: 1 });
});

test('GET /api/alerts/summary is admin-only and reports the de-duplication numbers', async () => {
  const rt = await start();
  rt.alerts.ingest(breach('RPT_200', 0));
  rt.alerts.ingest(breach('RPT_200', 1)); // held back
  assert.equal((await rt.http(T.viewer(), '/api/alerts/summary')).status, 403);
  assert.equal((await rt.http(T.owner2(), '/api/alerts/summary')).status, 403);
  const s = (await rt.http(T.admin(), '/api/alerts/summary')).body.data;
  assert.equal(s.observations, 2);
  assert.equal(s.emitted.TRIGGERED, 1);
  assert.equal(s.suppressed.LATENCY, 1);
  assert.equal(s.last_event_id, 1);
});
