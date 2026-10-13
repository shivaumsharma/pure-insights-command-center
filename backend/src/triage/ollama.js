// The local-model triager: asks a model running in Ollama (https://ollama.com) to explain an alert from an evidence pack. It is the free
// alternative to llm.js: no account, no key, no cost, and with the default host nothing leaves this machine.
//
// Its output is never trusted either. It goes through the same validator as every other triager (validator.js). A small local model will
// misread evidence more often than a large hosted one, which is exactly what the validator is there to catch, so a worse model gives a
// more informative measurement, not a broken one.
//
// What is sent, per request, to the Ollama host: the evidence pack and the instructions in prompt.js (the same as for the hosted model).
// With the default host (localhost) that is a request to a process on this computer.
//
// The request shape is Ollama's documented chat endpoint with a JSON schema in `format` (structured outputs). The adapter is tested
// against a stand-in HTTP server that mimics that endpoint (backend/test/triage-ollama.test.js) and has been run once against a real
// local Ollama; see docs/decisions.md D38 for what that run did and did not show.

import { z } from 'zod';
import { TriageError } from './errors.js';
import { SYSTEM_PROMPT, userMessage } from './prompt.js';
import { SuggestionSchema } from './schema.js';

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b';

// The schema the model must follow. Ollama constrains decoding to it, so a model that cannot reason well still produces the right shape;
// whether what it says is TRUE is the validator's job.
const { $schema: _omit, ...RESPONSE_SCHEMA } = z.toJSONSchema(SuggestionSchema);

export function isLocalHost(host) {
  try {
    const { hostname } = new URL(host);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

export function normaliseOllamaHost(host = DEFAULT_OLLAMA_HOST) {
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`OLLAMA_HOST must be a URL such as ${DEFAULT_OLLAMA_HOST}, not '${host}'`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('OLLAMA_HOST must start with http:// or https://');
  return url.origin;
}

export function createOllamaTriager({
  host = DEFAULT_OLLAMA_HOST,
  model = DEFAULT_OLLAMA_MODEL,
  timeoutMs = 120_000, // local models on a laptop can take a while, especially on the first request while the model loads
  maxOutputTokens = 2000,
  contextTokens = 8192, // Ollama's default window (4096) is too small for the prompt plus the evidence plus the answer
  fetchImpl = globalThis.fetch,
} = {}) {
  const origin = normaliseOllamaHost(host);

  return {
    name: 'ollama',
    model,
    host: origin,
    async triage(evidence) {
      let body;
      try {
        const res = await fetchImpl(`${origin}/api/chat`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            format: RESPONSE_SCHEMA,
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage(evidence) },
            ],
            // temperature 0 so the same alert gets the same answer; local models accept sampling options (the hosted ones do not).
            options: { temperature: 0, num_ctx: contextTokens, num_predict: maxOutputTokens },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          // Say what happened, not what the server said back.
          const hint = res.status === 404 ? ' The model may not be installed: run "ollama pull" for it.' : '';
          throw new TriageError('PROVIDER_ERROR', `The local model server returned an error (status ${res.status}).${hint}`);
        }
        body = await res.json();
      } catch (err) {
        if (err instanceof TriageError) throw err;
        if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new TriageError('TIMEOUT', 'The local model did not answer in time.');
        if (err instanceof SyntaxError) throw new TriageError('PROVIDER_ERROR', 'The local model server sent a reply that could not be read.');
        throw new TriageError('PROVIDER_ERROR', 'The local model server could not be reached. Is Ollama running?');
      }

      if (body?.done_reason === 'length') throw new TriageError('TRUNCATED', 'The local model answer was cut off.');

      // Anything that is not valid JSON in the right shape comes back as null, which the validator rejects (and the reason is counted).
      let suggestion = null;
      try {
        const parsed = SuggestionSchema.safeParse(JSON.parse(body?.message?.content ?? ''));
        if (parsed.success) suggestion = parsed.data;
      } catch {
        suggestion = null;
      }

      const hasCounts = Number.isFinite(body?.prompt_eval_count) || Number.isFinite(body?.eval_count);
      return {
        suggestion,
        usage: hasCounts ? { input_tokens: body.prompt_eval_count ?? 0, output_tokens: body.eval_count ?? 0 } : null,
      };
    },
  };
}
