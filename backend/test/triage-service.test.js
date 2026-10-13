// The triage service and its routes, driven by fake AI triagers that return good, false, unverifiable and failing answers.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { createAlertService } from '../src/alerts/service.js';
import { createApp } from '../src/app.js';
import { createTokenService } from '../src/auth/tokens.js';
import { createUserStore } from '../src/auth/users.js';
import { loadConfig } from '../src/config.js';
import { DEFAULT_OUT } from '../src/pipeline/pipeline.js';
import { loadStore } from '../src/store.js';
import { baselineTriager } from '../src/triage/baseline.js';
import { buildEvidence } from '../src/triage/evidence.js';
import { TriageError } from '../src/triage/llm.js';
import { createTriageService } from '../src/triage/service.js';
import { validateSuggestion } from '../src/triage/validator.js';

const SECRET = crypto.randomBytes(32).toString('hex');
const cleanup = [];
after(() => cleanup.forEach((f) => f()));
const tmpDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-tsvc-')); cleanup.push(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

const admin = { email: 'admin@test.local', role: 'admin' };
const viewer = { email: 'viewer@test.local', role: 'viewer' };
const owner2 = { email: 'user_2@company.com', role: 'owner' }; // owns RPT_200, RPT_219, RPT_255, RPT_294
const owner6 = { email: 'user_6@company.com', role: 'owner' };

// A real alert stream: run real readings through the alert service and keep the explainable alerts.
const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: tmpDir() });
function alertStream() {
  const svc = createAlertService({ store, historyCapacity: 5000 });
  for (const o of store.observations().slice(0, 700)) svc.ingest(o);
  return svc;
}
const alerts = alertStream();
const explainable = alerts.list(admin).filter((a) => a.lifecycle !== 'RESOLVED').reverse(); // oldest first
const resolved = alerts.list(admin).find((a) => a.lifecycle === 'RESOLVED');
const forOwner2 = explainable.filter((a) => store.summary(a.report_id).owner_email === owner2.email);
assert.ok(explainable.length > 20 && resolved && forOwner2.length > 0, 'the fixture stream needs variety');

// Fake AI triagers. `produce(evidence)` returns the suggestion the "model" gives.
const fakeAi = (produce, name = 'anthropic') => {
  const t = { name, model: 'fake-model', calls: 0, async triage(ev) { t.calls++; return { suggestion: await produce(ev, t.calls), usage: { input_tokens: 100, output_tokens: 40 } }; } };
  return t;
};
const honest = async (ev) => (await baselineTriager.triage(ev)).suggestion;
const lying = async (ev) => { const s = structuredClone(await honest(ev)); if (s.causes[0]) s.causes[0].cites[0].value = '123456'; else s.causes = [{ kind: 'HIGH_QUERY_VOLUME', claim: 'Many queries.', cites: [{ evidence: 'O1', field: 'query_count_last_30d', value: '1' }], confidence: 0.6 }]; return s; };
const unverifiable = async () => ({ summary: 'Probably a deployment.', causes: [{ kind: 'OTHER', claim: 'A deployment may have changed something.', cites: [], confidence: 0.4 }], actions: [{ kind: 'MONITOR', rationale: 'Watch it.', cites: [] }], needs_human: false, confidence: 0.5 });

const make = (opts = {}) => createTriageService({ store, alerts, runtimeDir: tmpDir(), logger: { error() {} }, ...opts });
const pick = (n = 0) => explainable[n].event_id;

// ------------------------------------------------------------------ the gate

test('without an AI, the rule-based triager answers; the result is cached and identical the second time', async () => {
  const svc = make();
  const a = await svc.get(pick(0), admin);
  assert.equal(a.triager, 'baseline');
  assert.ok(['TRUSTED', 'UNDER_REVIEW'].includes(a.status));
  const b = await svc.get(pick(0), admin);
  assert.deepEqual(b, a);
  assert.equal(svc.stats().explained, 1);
});

test('a true AI suggestion is TRUSTED: everyone sees it, with the evidence behind it', async () => {
  // Pick an alert the rules can explain, so the check is real rather than vacuous.
  const explainableByRules = [];
  for (const alert of forOwner2) {
    const ev = buildEvidence({ alert, store });
    if (validateSuggestion((await baselineTriager.triage(ev)).suggestion, ev).status === 'TRUSTED') explainableByRules.push(alert);
  }
  assert.ok(explainableByRules.length > 0, 'the stream has an alert for owner2 that the data can explain');
  const id = explainableByRules[0].event_id;

  const ai = fakeAi(honest);
  const svc = make({ aiTriager: ai });
  for (const user of [viewer, owner2, admin]) {
    const v = await svc.get(id, user);
    assert.equal(v.status, 'TRUSTED');
    assert.ok(v.suggestion.causes.length > 0 && v.evidence.items.A);
    assert.equal(v.triager, 'anthropic');
  }
  assert.equal(ai.calls, 1, 'one model call, however many people look');
});

test('a FALSE AI suggestion is withheld: non-admins get no content, admins see the suggestion and exactly why it failed', async () => {
  const svc = make({ aiTriager: fakeAi(lying) });
  const id = pick(1);
  const viewerView = await svc.get(id, viewer);
  assert.equal(viewerView.status, 'WITHHELD');
  assert.ok(!('suggestion' in viewerView) && !('evidence' in viewerView) && !('findings' in viewerView));
  assert.match(viewerView.message, /did not match the data/);

  const adminView = await svc.get(id, admin);
  assert.equal(adminView.validation, 'REJECTED');
  assert.ok(adminView.findings.some((f) => f.severity === 'error' && /VALUE_MISMATCH|CAUSE_CONTRADICTED/.test(f.code)));
  assert.ok(adminView.suggestion);
  assert.equal(svc.listReview().length, 1);
});

test('an UNVERIFIABLE suggestion is held for review; approving it shows it, and says a person reviewed it', async () => {
  const svc = make({ aiTriager: fakeAi(unverifiable) });
  const id = pick(2);
  const before = await svc.get(id, viewer);
  assert.equal(before.status, 'UNDER_REVIEW');
  assert.ok(!('suggestion' in before));
  assert.equal(svc.listReview()[0].findings.some((f) => f.code === 'OTHER_UNVERIFIABLE'), true);

  const approved = svc.review({ eventId: id, decision: 'approve', note: 'Plausible, checked with the owner', actor: admin.email });
  assert.equal(approved.status, 'APPROVED');
  assert.deepEqual([approved.review.state, approved.review.by, approved.review.note], ['approved', admin.email, 'Plausible, checked with the owner']);

  const after = await svc.get(id, viewer);
  assert.equal(after.status, 'APPROVED');
  assert.equal(after.reviewed_by_a_person, true);
  assert.ok(after.suggestion);
  assert.ok(!('findings' in after), 'review reasons stay with admins');
  assert.equal(svc.listReview().length, 0);
  assert.equal(svc.listReview({ state: 'approved' }).length, 1);
});

test('dismissing hides it for everyone but admins; a decision cannot be made twice', async () => {
  const svc = make({ aiTriager: fakeAi(unverifiable) });
  const id = pick(3);
  await svc.get(id, viewer);
  svc.review({ eventId: id, decision: 'dismiss', actor: admin.email });
  assert.equal((await svc.get(id, viewer)).status, 'DISMISSED');
  assert.ok(!('suggestion' in (await svc.get(id, viewer))));
  assert.throws(() => svc.review({ eventId: id, decision: 'approve', actor: admin.email }), (e) => e.status === 409 && e.code === 'ALREADY_REVIEWED');
});

test('a suggestion that contradicts the data can only be dismissed, never approved', async () => {
  const svc = make({ aiTriager: fakeAi(lying) });
  const id = pick(4);
  await svc.get(id, admin);
  assert.throws(() => svc.review({ eventId: id, decision: 'approve', actor: admin.email }), (e) => e.status === 409 && e.code === 'CANNOT_APPROVE');
  assert.equal(svc.review({ eventId: id, decision: 'dismiss', actor: admin.email }).status, 'DISMISSED');
});

test('reviewing something that was never held is a 404', async () => {
  const svc = make();
  assert.throws(() => svc.review({ eventId: 999999, decision: 'approve', actor: 'a' }), (e) => e.status === 404);
});

// ------------------------------------------------------------------ AI failure, budget, load

test('when the AI fails, the rule-based triager answers instead, and the fallback is recorded', async () => {
  for (const failure of [new TriageError('TIMEOUT', 'slow'), new TriageError('REFUSED', 'no'), new Error('boom')]) {
    const ai = fakeAi(async () => { throw failure; });
    const svc = make({ aiTriager: ai });
    const v = await svc.get(pick(5), admin);
    assert.equal(v.triager, 'baseline');
    assert.equal(v.fallback.from, 'anthropic');
    assert.ok(['TRUSTED', 'UNDER_REVIEW'].includes(v.status));
    assert.equal(svc.stats().fallbacks, 1);
  }
});

test('a model call budget caps spend: beyond it, the rule-based triager answers', async () => {
  const ai = fakeAi(honest);
  const svc = make({ aiTriager: ai, maxModelCallsPerHour: 2 });
  const first = [await svc.get(pick(6), admin), await svc.get(pick(7), admin)];
  const third = await svc.get(pick(8), admin);
  assert.deepEqual(first.map((v) => v.triager), ['anthropic', 'anthropic']);
  assert.equal(third.triager, 'baseline');
  assert.equal(ai.calls, 2);
  assert.equal(svc.stats().fallbacks, 1);
});

test('the budget window moves: after an hour the AI is used again', async () => {
  let clock = Date.UTC(2026, 9, 12, 12, 0, 0);
  const ai = fakeAi(honest);
  const svc = make({ aiTriager: ai, maxModelCallsPerHour: 1, now: () => new Date(clock) });
  await svc.get(pick(9), admin);
  assert.equal((await svc.get(pick(10), admin)).triager, 'baseline');
  clock += 61 * 60_000;
  assert.equal((await svc.get(pick(11), admin)).triager, 'anthropic');
});

test('per-user rate limit applies to new explanations only, per user, and resets with time', async () => {
  let clock = Date.UTC(2026, 9, 12, 12, 0, 0);
  const svc = make({ maxGenerationsPerMinute: 2, now: () => new Date(clock) });
  await svc.get(pick(12), viewer);
  await svc.get(pick(13), viewer);
  await svc.get(pick(12), viewer); // cached: free
  await assert.rejects(() => svc.get(pick(14), viewer), (e) => e.status === 429 && e.code === 'RATE_LIMITED');
  await svc.get(pick(14), admin); // another user is unaffected
  clock += 61_000;
  await svc.get(pick(15), viewer); // the window passed
});

test('concurrent requests for the same alert share one generation', async () => {
  const ai = fakeAi(async (ev) => { await new Promise((r) => setTimeout(r, 40)); return honest(ev); });
  const svc = make({ aiTriager: ai });
  const results = await Promise.all([svc.get(pick(16), admin), svc.get(pick(16), viewer), svc.get(pick(16), admin)]);
  assert.equal(ai.calls, 1);
  assert.equal(new Set(results.map((r) => r.created_at)).size, 1);
});

// ------------------------------------------------------------------ who may ask

test('an owner cannot explain another owner\'s alert (404), nobody can explain a resolved alert (400) or an unknown one (404)', async () => {
  const svc = make();
  const mine = forOwner2[0].event_id;
  assert.ok(await svc.get(mine, owner2));
  await assert.rejects(() => svc.get(mine, owner6), (e) => e.status === 404);
  await assert.rejects(() => svc.get(resolved.event_id, admin), (e) => e.status === 400);
  await assert.rejects(() => svc.get(987654, admin), (e) => e.status === 404);
});

test('nothing personal or costly is in any view, for any role', async () => {
  const svc = make({ aiTriager: fakeAi(honest) });
  for (let i = 17; i < 27; i++) {
    for (const user of [viewer, admin]) {
      const text = JSON.stringify(await svc.get(pick(i), user));
      assert.ok(!text.includes('@'), 'an email address');
      assert.ok(!/Analytics Dashboard|cost|credit|usd/i.test(text), 'a name or cost');
    }
  }
});

// ------------------------------------------------------------------ persistence and statistics

test('review state and results survive a restart, and are not regenerated', async () => {
  const dir = tmpDir();
  const ai = fakeAi(unverifiable);
  const first = createTriageService({ store, alerts, aiTriager: ai, runtimeDir: dir });
  const id = pick(27);
  await first.get(id, admin);
  first.review({ eventId: id, decision: 'approve', actor: admin.email });

  const ai2 = fakeAi(unverifiable);
  const second = createTriageService({ store, alerts, aiTriager: ai2, runtimeDir: dir });
  const v = await second.get(id, viewer);
  assert.equal(v.status, 'APPROVED');
  assert.equal(ai2.calls, 0);
});

test('a corrupt state file stops startup with a clear message instead of silently discarding reviews', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'triage.json'), '{not json');
  assert.throws(() => createTriageService({ store, alerts, runtimeDir: dir }), /triage\.json is not valid JSON/);
});

test('statistics compare the AI with the rule-based control on the same alerts', async () => {
  const svc = make({ aiTriager: fakeAi(async (ev, n) => (n % 2 === 0 ? lying(ev) : honest(ev))) });
  for (let i = 28; i < 36; i++) await svc.get(pick(i), admin);
  const s = svc.stats();
  assert.equal(s.explained, 8);
  assert.equal(s.ai_vs_rules.compared, 8);
  assert.equal(s.model_calls, 8);
  assert.deepEqual(s.provider, { name: 'anthropic', model: 'fake-model' });
  assert.equal(s.tokens.input, 800);
  assert.ok(s.ai_vs_rules.ai_rejected >= 3, `half the answers were false: ${JSON.stringify(s.ai_vs_rules)}`);
  assert.ok(s.ai_vs_rules.ai_trusted < s.ai_vs_rules.rules_trusted, `false answers cost the AI trusted results the rules kept: ${JSON.stringify(s.ai_vs_rules)}`);
  assert.ok(s.finding_codes.VALUE_MISMATCH > 0 || s.finding_codes.CAUSE_CONTRADICTED > 0);
  assert.equal(s.validation.TRUSTED + (s.validation.NEEDS_REVIEW ?? 0) + (s.validation.REJECTED ?? 0), 8);
});

// ------------------------------------------------------------------ over HTTP

async function startHttp(svcOptions = {}) {
  const runtimeDir = tmpDir();
  const triage = createTriageService({ store, alerts, runtimeDir, logger: { error() {} }, ...svcOptions });
  const tokens = createTokenService({ secret: SECRET, ttl: '1h' });
  const userStore = await createUserStore([{ email: 'x@x.co', name: 'x', role: 'viewer', password: 'unused-password-1' }]);
  const config = { ...loadConfig({ JWT_SECRET: SECRET }), runtimeDir };
  const app = createApp({ store, userStore, tokens, config, alerts, triage, logger: { error() {} } });
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, who, body) => {
    const res = await fetch(base + url, {
      method,
      headers: { ...(who ? { authorization: `Bearer ${tokens.sign(who)}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json() };
  };
  return { call, triage };
}

test('routes: every role that can see an alert may ask; admin-only routes refuse everyone else', async () => {
  const { call } = await startHttp({ aiTriager: fakeAi(unverifiable) });
  const id = forOwner2.find((a) => a.lifecycle !== 'RESOLVED').event_id;
  assert.equal((await call('GET', `/api/alerts/${id}/triage`)).status, 401);
  for (const who of [admin, viewer, owner2]) assert.equal((await call('GET', `/api/alerts/${id}/triage`, who)).status, 200, who.role);
  assert.equal((await call('GET', `/api/alerts/${id}/triage`, owner6)).status, 404); // not theirs

  for (const [method, url, body] of [['GET', '/api/triage/review'], ['GET', '/api/triage/stats'], ['POST', `/api/triage/${id}/review`, { decision: 'approve' }]]) {
    for (const who of [viewer, owner2]) assert.equal((await call(method, url, who, body)).status, 403, `${who.role} ${method} ${url}`);
  }
  assert.equal((await call('GET', '/api/triage/review', admin)).body.data.length, 1);
  assert.equal((await call('GET', '/api/triage/stats', admin)).status, 200);
  const done = await call('POST', `/api/triage/${id}/review`, admin, { decision: 'approve', note: 'ok' });
  assert.equal(done.status, 200);
  assert.equal(done.body.data.status, 'APPROVED');
  assert.equal((await call('POST', `/api/triage/${id}/review`, admin, { decision: 'approve' })).status, 409);
});

test('routes: bad ids and bad review bodies are 400s', async () => {
  const { call } = await startHttp();
  for (const bad of ['abc', '1.5', '-1', '99999999999']) assert.equal((await call('GET', `/api/alerts/${bad}/triage`, admin)).status, 400, bad);
  const id = pick(40);
  for (const body of [{}, { decision: 'maybe' }, { decision: 'approve', note: 5 }, { decision: 'approve', note: 'x'.repeat(501) }]) {
    assert.equal((await call('POST', `/api/triage/${id}/review`, admin, body)).status, 400, JSON.stringify(body).slice(0, 40));
  }
  assert.equal((await call('GET', '/api/triage/review?state=bogus', admin)).status, 400);
});

test('routes: asking too often is a 429, and a resolved alert is a 400', async () => {
  const { call } = await startHttp({ maxGenerationsPerMinute: 1 });
  assert.equal((await call('GET', `/api/alerts/${pick(41)}/triage`, viewer)).status, 200);
  const limited = await call('GET', `/api/alerts/${pick(42)}/triage`, viewer);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error.code, 'RATE_LIMITED');
  assert.equal((await call('GET', `/api/alerts/${resolved.event_id}/triage`, admin)).status, 400);
});
