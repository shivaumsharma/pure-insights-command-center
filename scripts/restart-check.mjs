// Runs the REAL browser feed client (frontend/src/lib/liveFeed.js) against the REAL server, restarts the server mid-stream,
// and checks that alerts keep arriving afterwards instead of being dropped as "duplicates".
//
//   npm run smoke:restart
//
// Why it exists: event ids restart at 1 when the server restarts. A client resuming from its old id would treat every new alert as
// one it had already seen. Unit tests on each side pass either way; only a real restart shows the problem (decision D31).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { createLiveFeed } from '../frontend/src/lib/liveFeed.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-restart-'));
const password = 'rs-' + crypto.randomBytes(8).toString('hex');
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ users: [{ email: 'rs@test.local', name: 'rs', role: 'admin', password }] }));
const env = { ...process.env, PORT: String(port), USERS_FILE: path.join(tmp, 'users.json'), RUNTIME_DIR: path.join(tmp, 'rt'), JWT_SECRET: crypto.randomBytes(32).toString('hex'), REPLAY_EVENTS_PER_SECOND: '10' };

let child = null;
// Run 1 replays fast so event ids climb well past 100; run 2 replays slowly so the new run's ids are still small when the client
// reconnects. That makes "new ids are lower than the old position" true every time, which is the case that used to break.
const startServer = async (eventsPerSecond) => {
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'backend/src/server.js'], { cwd: ROOT, env: { ...env, REPLAY_EVENTS_PER_SECOND: String(eventsPerSecond) } });
  child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* not up yet */ } await sleep(150); }
  throw new Error('server did not start');
};
const killServer = async () => { child.kill(); await sleep(500); };

const login = async () => {
  const r = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'rs@test.local', password }) });
  return (await r.json()).token;
};

await startServer(200);
const token = await login();

const seen = []; const gaps = []; const statuses = [];
const feed = createLiveFeed({
  url: `ws://127.0.0.1:${port}/ws`, getToken: () => token, WebSocketImpl: WebSocket,
  baseDelayMs: 200, maxDelayMs: 1000,
  onAlert: (a) => seen.push({ id: a.event_id, run: seen.run }), onGap: (g) => gaps.push(g), onStatus: (s) => statuses.push(s),
});
seen.run = 1;
feed.start();

const waitFor = async (cond, what, ms = 20000) => { const t = Date.now(); while (!cond()) { if (Date.now() - t > ms) throw new Error('timed out waiting for ' + what); await sleep(50); } };
let ok = true;
const report = (pass, msg) => { console.log(`${pass ? 'PASS' : 'FAIL'}  ${msg}`); if (!pass) ok = false; };

try {
  await waitFor(() => seen.length > 0 && Math.max(...seen.map((s) => s.id)) >= 100, 'event ids to pass 100');
  const before = seen.length; const highest = Math.max(...seen.map((s) => s.id));
  report(true, `run 1: received ${before} alerts, highest event id ${highest}`);

  await killServer();
  seen.run = 2;
  await startServer(10); // same port, same signing secret, so the old token is still valid, but event ids start again from 1
  await waitFor(() => statuses.at(-1) === 'live' && seen.some((s) => s.run === 2), 'alerts after the restart');
  await sleep(1500);

  const after = seen.filter((s) => s.run === 2);
  report(after.length > 0, `run 2: ${after.length} alerts delivered after the restart (ids ${after[0]?.id}..${after.at(-1)?.id})`);
  report(after[0].id < highest, `the new alerts carry LOWER ids than before (${after[0].id} < ${highest}): they would have been dropped as duplicates without the fix`);
  report(after[0].id >= 1, `alerts 1-${after[0].id - 1} of the new run happened before the client reconnected; the gap notice makes the page refetch them instead of replaying`);
  report(gaps.length === 1 && gaps[0].reason === 'restarted', `the page is told to refresh its lists exactly once (gap notices: ${gaps.length}, reason: ${gaps[0]?.reason})`);
  report(statuses.includes('reconnecting') && statuses.at(-1) === 'live', `status went ${[...new Set(statuses)].join(' -> ')}`);
  const ids = after.map((s) => s.id);
  report(ids.every((v, i) => i === 0 || v > ids[i - 1]), 'ids after the restart are strictly increasing (no repeats)');
} catch (err) {
  report(false, err.message);
} finally {
  feed.stop(); await killServer(); fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(ok ? '\nRestart recovery works end to end.' : '\nFAILED');
process.exit(ok ? 0 : 1);
