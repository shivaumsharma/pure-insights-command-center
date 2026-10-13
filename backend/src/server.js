// Starts the API, the WebSocket hub and the telemetry replay:  npm start   (run `npm run data:build` once first)

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAlertService } from './alerts/service.js';
import { createSimulator } from './alerts/simulator.js';
import { createApp } from './app.js';
import { createTokenService } from './auth/tokens.js';
import { createUserStore, readUsersFile } from './auth/users.js';
import { loadConfig } from './config.js';
import { createHub } from './realtime/hub.js';
import { createAiTriager, describeAi } from './triage/provider.js';
import { createTriageService } from './triage/service.js';
import { loadStore } from './store.js';

const config = loadConfig();

if (!fs.existsSync(path.join(config.dataDir, 'dq_report.json'))) {
  console.error(`No processed data in ${config.dataDir}. Run "npm run data:build" first.`);
  process.exit(1);
}

const store = loadStore({ dataDir: config.dataDir, runtimeDir: config.runtimeDir });
const userStore = await createUserStore(readUsersFile(config.usersFile));
const tokens = createTokenService({ secret: config.jwtSecret, ttl: config.tokenTtl });
const alerts = createAlertService({ store, cooldownMs: config.alertCooldownMs, historyCapacity: config.alertHistoryCapacity });

const aiTriager = createAiTriager(config);
const triage = createTriageService({ store, alerts, aiTriager, runtimeDir: config.runtimeDir, maxModelCallsPerHour: config.aiMaxCallsPerHour });

const app = createApp({ store, userStore, tokens, config, alerts, triage });
const server = http.createServer(app);
const hub = createHub({ server, tokens, alerts, config });
const simulator = createSimulator({
  observations: store.observations(),
  eventsPerSecond: config.replayEventsPerSecond,
  onEvent: (obs) => alerts.ingest(obs),
});

server.on('error', (err) => {
  // e.g. EADDRINUSE: fail loudly instead of pretending to be up.
  console.error(`Could not listen on port ${config.port}: ${err.message}. Set PORT to use another port.`);
  process.exit(1);
});

server.listen(config.port, () => {
  console.log(`Pure Insights API on http://localhost:${config.port}  (WebSocket: ws://localhost:${config.port}/ws)`);
  if (!process.env.JWT_SECRET) console.log('JWT_SECRET not set: using a random secret for this run (tokens end on restart).');
  console.log(`${userStore.count()} demo users loaded from ${path.relative(process.cwd(), config.usersFile)}`);
  console.log(describeAi(config));
  if (config.replayEnabled) {
    simulator.start();
    console.log(`Replaying ${store.observations().length} observations at ${config.replayEventsPerSecond}/s (set REPLAY_ENABLED=false to disable).`);
  }
});

function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  simulator.stop();
  hub.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
