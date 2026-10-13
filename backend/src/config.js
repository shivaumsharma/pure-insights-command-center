import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_COOLDOWN_MS } from './alerts/rules.js';
import { DEFAULT_OUT } from './pipeline/pipeline.js';
import { DEFAULT_OLLAMA_MODEL, normaliseOllamaHost } from './triage/ollama.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const AI_PROVIDERS = ['baseline', 'anthropic', 'ollama'];

function chooseAiProvider(env) {
  const provider = env.AI_PROVIDER ?? 'baseline';
  if (!AI_PROVIDERS.includes(provider)) throw new Error(`AI_PROVIDER must be one of ${AI_PROVIDERS.map((p) => `'${p}'`).join(', ')}, not '${provider}'`);
  return provider;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const aiProvider = chooseAiProvider(env);
  let jwtSecret = env.JWT_SECRET;
  if (!jwtSecret) {
    if (production) throw new Error('JWT_SECRET is required when NODE_ENV=production');
    // Development: a fresh secret per process. Tokens stop working on restart, which is the safe failure.
    jwtSecret = crypto.randomBytes(32).toString('hex');
  } else if (jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }

  return {
    production,
    port: Number(env.PORT ?? 3101),
    jwtSecret,
    tokenTtl: env.TOKEN_TTL ?? '8h',
    dataDir: env.DATA_DIR ?? DEFAULT_OUT,
    runtimeDir: env.RUNTIME_DIR ?? path.join(ROOT, 'data/runtime'),
    staticDir: env.STATIC_DIR ?? path.join(ROOT, 'frontend/dist'),
    usersFile: env.USERS_FILE ?? path.join(ROOT, 'backend/config/demo-users.json'),
    loginMaxFailures: 5,

    // Real-time alerts
    replayEnabled: env.REPLAY_ENABLED !== 'false',
    replayEventsPerSecond: Number(env.REPLAY_EVENTS_PER_SECOND ?? 10),
    alertCooldownMs: DEFAULT_COOLDOWN_MS,
    alertHistoryCapacity: 2000,
    wsAuthTimeoutMs: 5000,
    wsHeartbeatMs: 30_000,
    wsMaxConnections: 200,
    wsMaxPerUser: 5,
    wsMaxPayload: 4096,

    // AI triage. Off unless explicitly chosen: having an API key in the environment must not, by itself, start sending data to a
    // third party. The rule-based triager (no AI) is the default and works without any key.
    // 'anthropic' sends the evidence pack to a hosted model (needs ANTHROPIC_API_KEY, costs money). 'ollama' sends it to a model running
    // locally (free, no key; with the default host it never leaves this computer).
    aiProvider,
    aiModel: env.AI_MODEL ?? (aiProvider === 'ollama' ? DEFAULT_OLLAMA_MODEL : 'claude-opus-5-5'),
    // A local model on a laptop is much slower than a hosted one, so it gets a longer default.
    aiTimeoutMs: Number(env.AI_TIMEOUT_MS ?? (aiProvider === 'ollama' ? 120_000 : 30_000)),
    aiMaxCallsPerHour: Number(env.AI_MAX_CALLS_PER_HOUR ?? 60),
    ollamaHost: aiProvider === 'ollama' ? normaliseOllamaHost(env.OLLAMA_HOST) : null,
    // Origins allowed to open the WebSocket from a browser (non-browser clients send no Origin). Vite dev server by default.
    allowedOrigins: (env.ALLOWED_ORIGINS ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map((o) => o.trim()).filter(Boolean),
    loginWindowMs: 15 * 60 * 1000,
  };
}
