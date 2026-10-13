// Prints, as JSON, what the app itself produces from the processed data: every alert (one pass over the readings, in time order) and
// the causes the rule-based explainer finds for each alert that is not a resolution.
// validation/validate.py runs this and compares it with its own, independently derived, figures. Nothing here decides anything.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAlertService } from '../backend/src/alerts/service.js';
import { createSimulator } from '../backend/src/alerts/simulator.js';
import { DEFAULT_OUT } from '../backend/src/pipeline/pipeline.js';
import { loadStore } from '../backend/src/store.js';
import { baselineTriager } from '../backend/src/triage/baseline.js';
import { buildEvidence } from '../backend/src/triage/evidence.js';

const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-validate-'));
try {
  const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir });
  const service = createAlertService({ store, historyCapacity: 10_000 });
  const total = store.observations().length;
  const sim = createSimulator({ observations: store.observations(), onEvent: (o) => service.ingest(o) });
  for (let i = 0; i < total; i++) sim.step(); // exactly one pass over the data

  const alerts = service.list({ email: 'validate@local', role: 'admin' }).reverse(); // oldest first
  const explanations = {};
  for (const alert of alerts) {
    if (alert.lifecycle === 'RESOLVED') continue; // a resolution has nothing to explain
    const { suggestion } = await baselineTriager.triage(buildEvidence({ alert, store }));
    explanations[alert.event_id] = suggestion.causes.map((c) => c.kind).sort();
  }

  const usage = store.awsUsage();
  process.stdout.write(JSON.stringify({
    readings: total,
    awsUsage: { rate: usage.fleet_aws_per_view, ratio: usage.mismatch_ratio, readings: usage.readings.map((r) => [r.observation_id, r.views, r.aws_cost_usd, r.mismatch_type]) },
    alerts: alerts.map((a) => [a.event_id, a.observed_at, a.report_id, a.alert_type, a.lifecycle, a.severity, a.suppressed_since_last]),
    explanations,
  }));
} finally {
  fs.rmSync(runtimeDir, { recursive: true, force: true });
}
