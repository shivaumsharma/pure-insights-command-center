// Chooses the model-backed triager from the configuration, and says plainly where the evidence goes.
// 'baseline' (the default) means no model at all: the rule-based triager answers and nothing is sent anywhere.

import { createLlmTriager } from './llm.js';
import { createOllamaTriager, isLocalHost } from './ollama.js';

export function createAiTriager(config) {
  if (config.aiProvider === 'anthropic') return createLlmTriager({ model: config.aiModel, timeoutMs: config.aiTimeoutMs });
  if (config.aiProvider === 'ollama') return createOllamaTriager({ host: config.ollamaHost, model: config.aiModel, timeoutMs: config.aiTimeoutMs });
  return null;
}

// The line printed at startup. It must be accurate about where data goes, because that is the thing a reader will rely on.
export function describeAi(config) {
  if (config.aiProvider === 'anthropic') {
    return `AI triage: ON, hosted model ${config.aiModel}. Alert evidence (no names, emails or costs) is sent to the provider.`;
  }
  if (config.aiProvider === 'ollama') {
    return isLocalHost(config.ollamaHost)
      ? `AI triage: ON, local model ${config.aiModel} via Ollama at ${config.ollamaHost}. Alert evidence stays on this computer.`
      : `AI triage: ON, model ${config.aiModel} via Ollama at ${config.ollamaHost}. That is NOT this computer: alert evidence (no names, emails or costs) is sent there.`;
  }
  return 'AI triage: rule-based only. Set AI_PROVIDER=ollama (free, local) or AI_PROVIDER=anthropic (hosted, needs ANTHROPIC_API_KEY) to use a model.';
}
