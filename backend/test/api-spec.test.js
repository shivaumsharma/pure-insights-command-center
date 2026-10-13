// The API spec and the code must describe the same endpoints. Two checks:
//   1. Set equality: every endpoint written in docs/api-spec.md is defined in backend/src/routes, and every route defined there is documented.
//   2. Reality: every documented endpoint answers on a running server (it is not the "No such endpoint" fallback).
// A spec that drifts from the code is worse than no spec, and this is the cheapest way to stop it drifting.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAlertService } from '../src/alerts/service.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUserStore } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';
import { createTriageService } from '../src/triage/service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const normal = (p) => p.replace(/:[A-Za-z]+/g, ':p'); // :id and :eventId are the same kind of thing for this comparison

export function documentedEndpoints(markdown) {
  return [...markdown.matchAll(/`(GET|POST|PUT|DELETE) (\/[^`\s]*)`/g)].map((m) => `${m[1]} ${normal(m[2])}`);
}

// Routes are declared as router.get('/path', ...) in files that are mounted at /api (login and "me" at /api/auth).
export function definedEndpoints(routesDir) {
  const out = ['GET /healthz']; // declared in app.js
  for (const file of fs.readdirSync(routesDir).filter((f) => f.endsWith('.js'))) {
    const prefix = file === 'auth.js' ? '/api/auth' : '/api';
    const source = fs.readFileSync(path.join(routesDir, file), 'utf8');
    for (const m of source.matchAll(/router\.(get|post|put|delete)\(\s*'([^']+)'/g)) out.push(`${m[1].toUpperCase()} ${normal(prefix + m[2])}`);
  }
  return out;
}

const documented = documentedEndpoints(fs.readFileSync(path.join(ROOT, 'docs/api-spec.md'), 'utf8'));
const defined = definedEndpoints(path.join(ROOT, 'backend/src/routes'));

test('the spec and the code list the same endpoints, in both directions', () => {
  assert.ok(documented.length >= 20, `only ${documented.length} endpoints found in the spec; the parser or the spec has broken`);
  assert.ok(defined.length >= 20, `only ${defined.length} routes found in the code; the parser or the routes have changed shape`);
  const doc = new Set(documented);
  const code = new Set(defined);
  const missingFromCode = [...doc].filter((e) => !code.has(e));
  const missingFromSpec = [...code].filter((e) => !doc.has(e));
  assert.deepEqual(missingFromCode, [], `documented but not in the code: ${missingFromCode.join(', ')}`);
  assert.deepEqual(missingFromSpec, [], `in the code but not documented: ${missingFromSpec.join(', ')}`);
});

test('the parsers see what they should: a known endpoint, a parameter, and a route that is not documented', () => {
  assert.deepEqual(documentedEndpoints('`GET /api/a/:id` and `PUT /api/b` and GET /api/c and `PATCH /api/d`'), ['GET /api/a/:p', 'PUT /api/b']);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-routes-'));
  fs.writeFileSync(path.join(dir, 'x.js'), "router.get('/things/:thingId', a);\nrouter.post('/things', b);\n");
  fs.writeFileSync(path.join(dir, 'auth.js'), "router.post('/login', c);\n");
  try {
    assert.deepEqual(definedEndpoints(dir).sort(), ['GET /api/things/:p', 'GET /healthz', 'POST /api/auth/login', 'POST /api/things'].sort());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const cleanup = [];
after(() => cleanup.forEach((f) => f()));

test('every documented endpoint answers on a running server (none falls through to "No such endpoint")', async () => {
  const secret = crypto.randomBytes(32).toString('hex');
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-spec-'));
  cleanup.push(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir });
  const alerts = createAlertService({ store });
  const triage = createTriageService({ store, alerts, runtimeDir, logger: { error() {} } });
  const tokens = createTokenService({ secret, ttl: '1h' });
  const userStore = await createUserStore([{ email: 'admin@x.co', name: 'a', role: 'admin', password: 'unused-password-1' }]);
  const app = createApp({ store, userStore, tokens, config: { ...loadConfig({ JWT_SECRET: secret }), runtimeDir }, alerts, triage, logger: { error() {} } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const token = tokens.sign({ email: 'admin@x.co', role: 'admin' });

  for (const endpoint of new Set(documented)) {
    const [method, route] = endpoint.split(' ');
    const url = route.replace('/:p/', '/RPT_200/').replace(/\/:p$/, '/1').replace('/alerts/RPT_200/triage', '/alerts/1/triage').replace('/triage/RPT_200/review', '/triage/1/review');
    const res = await fetch(base + url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: method === 'GET' || method === 'DELETE' ? undefined : '{}' });
    const body = await res.json().catch(() => ({}));
    assert.ok(!(res.status === 404 && body?.error?.message === 'No such endpoint'), `${endpoint} (${url}) is documented but the server does not have it`);
  }
});
