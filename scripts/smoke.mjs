// Full-stack smoke test: starts the real server (UI + API + WebSocket) on a free port with throwaway accounts, and checks
// what a user would hit first. Run it after `npm run data:build` and `npm run web:build`:
//
//   npm run smoke
//
// It is meant to catch "each part passes its own tests but the product does not start", e.g. a missing build, a wrong
// path, a refused WebSocket origin, or a UI that is not being served. It does not replace the unit tests.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(import.meta.dirname, '..');
const failures = [];
const log = (ok, name, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures.push(name);
};
async function check(name, fn) {
  try {
    const detail = await fn();
    log(true, name, typeof detail === 'string' ? detail : '');
  } catch (err) {
    log(false, name, err.message);
  }
}
const expect = (cond, message) => { if (!cond) throw new Error(message); };

const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function websocket(url, { origin, onOpen, timeoutMs = 8000 }) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { headers: { Origin: origin } } : undefined);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('timed out')); }, timeoutMs);
    ws.on('unexpected-response', (req, res) => { clearTimeout(timer); resolve({ refused: res.statusCode }); });
    ws.on('error', () => {});
    ws.on('open', () => onOpen?.(ws, (value) => { clearTimeout(timer); ws.close(); resolve(value); }));
    if (!onOpen) ws.on('open', () => { clearTimeout(timer); ws.close(); resolve({ connected: true }); });
  });
}

const dist = path.join(ROOT, 'frontend/dist/index.html');
if (!fs.existsSync(dist)) {
  console.error('frontend/dist is missing. Run "npm run web:build" first.');
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'data/processed/dq_report.json'))) {
  console.error('data/processed is missing. Run "npm run data:build" first.');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-smoke-'));
const pw = () => crypto.randomBytes(12).toString('base64url');
const accounts = {
  admin: { email: 'smoke-admin@test.local', name: 'Smoke Admin', role: 'admin', password: pw() },
  viewer: { email: 'smoke-viewer@test.local', name: 'Smoke Viewer', role: 'viewer', password: pw() },
};
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: Object.values(accounts) }));

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let output = '';
const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'backend/src/server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    USERS_FILE: path.join(tmp, 'users.json'),
    RUNTIME_DIR: path.join(tmp, 'runtime'),
    JWT_SECRET: crypto.randomBytes(32).toString('hex'),
    REPLAY_EVENTS_PER_SECOND: '50',
  },
});
server.stdout.on('data', (d) => { output += d; });
server.stderr.on('data', (d) => { output += d; });
let exited = null;
server.on('exit', (code) => { exited = code; });

async function stop() {
  if (exited === null) server.kill();
  await sleep(200);
  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  let up = false;
  for (let i = 0; i < 100 && !up && exited === null; i++) {
    try { up = (await fetch(`${base}/healthz`)).ok; } catch { await sleep(150); }
  }
  if (!up) {
    log(false, 'server starts and answers /healthz', exited !== null ? `exited with code ${exited}` : 'no answer in 15 s');
    console.error('--- server output ---\n' + output);
    await stop();
    process.exit(1);
  }
  log(true, 'server starts and answers /healthz', `port ${port}`);

  const html = { accept: 'text/html' };
  let shell = '';
  await check('serves the app shell with a content security policy', async () => {
    const res = await fetch(`${base}/`, { headers: html });
    shell = await res.text();
    expect(res.status === 200, `status ${res.status}`);
    expect(shell.includes('<div id="root">'), 'no root element in the page');
    expect(/script-src 'self'/.test(res.headers.get('content-security-policy') ?? ''), 'missing or weak CSP');
  });
  await check('page addresses fall back to the app shell', async () => {
    const res = await fetch(`${base}/reports/RPT_204`, { headers: html });
    expect(res.status === 200 && (await res.text()).includes('<div id="root">'), `status ${res.status}`);
  });
  await check('the built script is served and cacheable', async () => {
    const asset = shell.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    expect(asset, 'no script tag in index.html');
    const res = await fetch(base + asset);
    expect(res.status === 200, `status ${res.status}`);
    expect(/immutable/.test(res.headers.get('cache-control') ?? ''), 'not cached as immutable');
  });
  await check('the API refuses requests without a token', async () => {
    const res = await fetch(`${base}/api/reports`);
    expect(res.status === 401, `status ${res.status}`);
    expect((await res.json()).error.code === 'UNAUTHENTICATED', 'unexpected error body');
  });

  const login = async (who) => {
    const { email, password } = accounts[who];
    const res = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    expect(res.status === 200, `login status ${res.status}`);
    return (await res.json()).token;
  };
  const tokens = {};
  await check('admin can sign in and read the fleet health', async () => {
    tokens.admin = await login('admin');
    const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    const body = await res.json();
    expect(res.status === 200 && body.reports.total === 100, `status ${res.status}, reports ${body.reports?.total}`);
    return `${body.reports.total} reports, ${body.reports.orphaned} without an owner`;
  });
  await check('a viewer is refused admin data by the server', async () => {
    tokens.viewer = await login('viewer');
    for (const p of ['/api/costs/reports', '/api/orphans', '/api/quarantine']) {
      const res = await fetch(base + p, { headers: { authorization: `Bearer ${tokens.viewer}` } });
      expect(res.status === 403, `${p} gave ${res.status}`);
    }
  });
  await check('the cost reconciliation reports its deliberate failure', async () => {
    const res = await fetch(`${base}/api/costs/reconciliation`, { headers: { authorization: `Bearer ${tokens.admin}` } });
    const body = await res.json();
    expect(body.summary.fail === 1 && body.summary.pass === 6, `summary ${JSON.stringify(body.summary)}`);
  });

  await check('the WebSocket accepts this page\'s own origin and delivers live alerts', async () => {
    const result = await websocket(`ws://127.0.0.1:${port}/ws`, {
      origin: base,
      onOpen: (ws, done) => {
        ws.send(JSON.stringify({ type: 'auth', token: tokens.admin }));
        let ready = false;
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'ready') ready = true;
          if (msg.type === 'alert' && ready) done({ alert: msg });
        });
      },
    });
    expect(!result.refused, `the server refused this page's own origin (HTTP ${result.refused})`);
    expect(result.alert?.event_id >= 1, 'no alert arrived');
    return `alert ${result.alert.event_id}: ${result.alert.message}`;
  });
  await check('the WebSocket refuses a foreign origin', async () => {
    const result = await websocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example', timeoutMs: 4000 });
    expect(result.refused === 403, `got ${JSON.stringify(result)}`);
  });
} finally {
  await stop();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join('\n- ')}\n\n--- server output ---\n${output}`);
  process.exit(1);
}
console.log('\nSmoke test passed.');
