// The data behind the "hosting cost against active views" chart: every reading with its flag, the fleet rate and the band.

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
import { loadStore } from '../src/store.js';

const cleanup = [];
after(() => cleanup.forEach((f) => f()));
const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-awsusage-'));
cleanup.push(() => fs.rmSync(runtimeDir, { recursive: true, force: true }));
const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir });

test('every clean reading is there once, with its views, hosting cost and the flag the SQL gave it', () => {
  const usage = store.awsUsage();
  const observations = store.observations();
  assert.equal(usage.readings.length, observations.length);
  assert.deepEqual(usage.readings.map((r) => r.observation_id), observations.map((o) => o.observation_id));
  const byId = new Map(observations.map((o) => [o.observation_id, o]));
  for (const r of usage.readings) {
    assert.equal(r.views, byId.get(r.observation_id).monthly_active_views);
    assert.equal(r.aws_cost_usd, byId.get(r.observation_id).aws_hosting_cost_usd);
  }
  // the flags are exactly the SQL's: same readings, same reason
  const flagged = usage.readings.filter((r) => r.mismatch_type !== null);
  assert.equal(flagged.length, store.awsMismatch().length);
  assert.equal(flagged.length, 625);
  const sql = new Map(store.awsMismatch().map((r) => [r.observation_id, r.mismatch_type]));
  for (const r of flagged) assert.equal(r.mismatch_type, sql.get(r.observation_id));
  assert.equal(usage.readings.filter((r) => r.mismatch_type === 'ZERO_VIEWS_WITH_COST').length, 4);
});

test('the fleet rate is the one the SQL used: the expected cost of every flagged reading is that rate times its views', () => {
  const { fleet_aws_per_view: rate, mismatch_ratio: ratio, readings } = store.awsUsage();
  assert.equal(ratio, 3);
  const views = new Map(readings.map((r) => [r.observation_id, r.views]));
  for (const row of store.awsMismatch()) {
    if (row.mismatch_type === 'ZERO_VIEWS_WITH_COST') continue; // no views, so no expectation
    assert.ok(Math.abs(row.expected_aws_usd - rate * views.get(row.observation_id)) <= 0.0051, `${row.observation_id}: ${row.expected_aws_usd} vs ${rate * views.get(row.observation_id)}`);
  }
  assert.ok(rate > 0 && rate < 10, `a plausible dollars-per-view figure: ${rate}`);
});

test('the flag agrees with the band: outside rate x 3 or rate / 3 is flagged, inside is not', () => {
  const { fleet_aws_per_view: rate, mismatch_ratio: ratio, readings } = store.awsUsage();
  for (const r of readings) {
    if (r.views === 0) {
      assert.equal(r.mismatch_type, r.aws_cost_usd > 0 ? 'ZERO_VIEWS_WITH_COST' : null);
      continue;
    }
    const expected = rate * r.views;
    const high = r.aws_cost_usd / expected >= ratio - 1e-9;
    const low = r.aws_cost_usd / expected <= 1 / ratio + 1e-9;
    assert.equal(r.mismatch_type !== null, high || low, `${r.observation_id} ${r.aws_cost_usd} against ${expected.toFixed(2)}`);
  }
});

async function start() {
  const secret = crypto.randomBytes(32).toString('hex');
  const tokens = createTokenService({ secret, ttl: '1h' });
  const userStore = await createUserStore([{ email: 'a@x.co', name: 'a', role: 'admin', password: 'unused-password-1' }]);
  const app = createApp({ store, userStore, tokens, config: { ...loadConfig({ JWT_SECRET: secret }), runtimeDir }, logger: { error() {} } });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  cleanup.push(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return async (who) => {
    const res = await fetch(`${base}/api/costs/aws-usage`, { headers: who ? { authorization: `Bearer ${tokens.sign(who)}` } : {} });
    return { status: res.status, body: await res.json() };
  };
}

test('the route is admin only, is not paged, and carries the fleet rate, the band and the placeholder-price flag', async () => {
  const get = await start();
  assert.equal((await get()).status, 401);
  assert.equal((await get({ email: 'v@x.co', role: 'viewer' })).status, 403);
  assert.equal((await get({ email: 'o@x.co', role: 'owner' })).status, 403);
  const { status, body } = await get({ email: 'a@x.co', role: 'admin' });
  assert.equal(status, 200);
  assert.equal(body.data.length, 1976); // every reading, not 50
  assert.deepEqual(Object.keys(body.data[0]).sort(), ['aws_cost_usd', 'mismatch_type', 'observation_id', 'report_id', 'views']);
  assert.equal(body.meta.mismatch_ratio, 3);
  assert.ok(body.meta.fleet_aws_per_view > 0);
  assert.equal(body.meta.price_is_placeholder, true);
  assert.equal(body.page, undefined);
});
