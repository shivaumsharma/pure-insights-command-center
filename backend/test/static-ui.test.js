import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUserStore } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { CONTENT_SECURITY_POLICY } from '../src/static-ui.js';
import { loadStore } from '../src/store.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const cleanup = [];
after(() => cleanup.forEach((f) => f()));

// A tiny fake build: index.html, a fingerprinted asset, and a file outside the folder that must stay unreachable.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ui-'));
const dist = path.join(root, 'dist');
fs.mkdirSync(path.join(dist, 'assets'), { recursive: true });
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>shell</title><div id="root"></div>');
fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1)');
fs.writeFileSync(path.join(dist, 'robots.txt'), 'x');
fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret');
cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));

async function serve(staticDir) {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-ui-rt-'));
  cleanup.push(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const config = { ...loadConfig({ JWT_SECRET: SECRET }), runtimeDir, staticDir };
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir });
  const userStore = await createUserStore([{ email: 'a@a.co', name: 'a', role: 'viewer', password: 'unused-password-9' }]);
  const app = createApp({ store, userStore, tokens: createTokenService({ secret: SECRET, ttl: '1h' }), config, logger: { error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return (url, headers = {}, method = 'GET') => fetch(base + url, { method, headers });
}

const HTML = { accept: 'text/html,application/xhtml+xml' };

test('page addresses get the app shell with a strict content security policy', async () => {
  const get = await serve(dist);
  for (const url of ['/', '/reports', '/reports/RPT_204', '/orphans?x=1']) {
    const res = await get(url, HTML);
    assert.equal(res.status, 200, url);
    assert.match(await res.text(), /<div id="root">/);
    assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.equal(res.headers.get('cache-control'), 'no-store');
  }
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'(;|$)/);
  assert.ok(!/unsafe-inline|unsafe-eval/.test(CONTENT_SECURITY_POLICY.split('style-src')[0]), 'no inline scripts');
});

test('fingerprinted assets are cached for a year; other files are not', async () => {
  const get = await serve(dist);
  const asset = await get('/assets/app-abc123.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.equal((await get('/robots.txt')).headers.get('cache-control'), 'no-store');
});

test('API and WebSocket paths are never answered with the HTML shell, even when the browser asks for HTML', async () => {
  const get = await serve(dist);
  for (const url of ['/api/nope', '/api/reports', '/healthz/x', '/ws']) {
    const res = await get(url, HTML);
    assert.notEqual(res.headers.get('content-type')?.includes('text/html'), true, url);
  }
  assert.equal((await get('/api/nope', HTML)).status, 401); // behind login, as before
  assert.equal((await get('/healthz')).status, 200);
});

test('only GET page requests are rewritten; missing files and other methods still 404', async () => {
  const get = await serve(dist);
  assert.equal((await get('/assets/missing.js')).status, 404);
  assert.equal((await get('/whatever.png', HTML)).status, 404); // has an extension: a missing file, not a page
  assert.equal((await get('/reports', HTML, 'POST')).status, 404);
  assert.equal((await get('/reports', { accept: 'application/json' })).status, 404); // not asking for a page
});

test('files outside the build folder cannot be reached', async () => {
  const get = await serve(dist);
  for (const url of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/..%2f..%2fsecret.txt']) {
    const res = await get(url, HTML);
    assert.ok(!(await res.text()).includes('top secret'), url);
  }
});

test('without a build, the API still works and pages simply 404', async () => {
  const get = await serve(path.join(root, 'does-not-exist'));
  assert.equal((await get('/', HTML)).status, 404);
  assert.equal((await get('/healthz')).status, 200);
});
