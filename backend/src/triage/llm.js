// The AI triager: asks Claude to explain an alert from an evidence pack. Its output is never trusted; it goes through the same
// validator as every other triager (see validator.js), and anything the data cannot back is held for a person.
//
// What leaves this machine, per request: the evidence pack only (report id, a few numeric readings, fleet baselines) and the
// instructions below. No owner emails, no report names, no cost data, and never the API key (the SDK reads it from the environment).
//
// STATUS: this adapter has been tested against a fake client that mimics the SDK's `messages.parse` result, and its request shape was
// written from the SDK's documented structured-output pattern. It has NOT been run against the live API from this repository, because
// that needs a key. `npm run triage:eval -- --llm` does that and reports real numbers (docs/decisions.md D34).

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { TriageError } from './errors.js';
import { SYSTEM_PROMPT, userMessage } from './prompt.js';
import { SuggestionSchema } from './schema.js';

// Re-exported so existing imports (the service, the eval script, the tests) keep working.
export { SYSTEM_PROMPT, TriageError };

export function createLlmTriager({ client, model = 'claude-opus-5-5', timeoutMs = 30_000, maxTokens = 8000 } = {}) {
  // Built lazily so a missing key only matters when the AI path is actually used.
  let sdk = client ?? null;

  return {
    name: 'anthropic',
    model,
    async triage(evidence) {
      let response;
      try {
        sdk ??= new Anthropic(); // inside the try: constructing the client can itself fail when credentials are missing
        // No sampling parameters, no prefill, no forced tool use: none of them are accepted on current Claude models.
        response = await sdk.messages.parse(
          {
            model,
            max_tokens: maxTokens,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: userMessage(evidence) }],
            output_config: { format: zodOutputFormat(SuggestionSchema) },
          },
          { timeout: timeoutMs },
        );
      } catch (err) {
        // Report what happened, never what the provider said back: error bodies can echo request content.
        if (err instanceof Anthropic.APIConnectionTimeoutError) throw new TriageError('TIMEOUT', 'The AI service did not answer in time.');
        if (err instanceof Anthropic.APIError) throw new TriageError('PROVIDER_ERROR', `The AI service returned an error (status ${err.status ?? 'unknown'}).`);
        throw new TriageError('PROVIDER_ERROR', 'The AI service could not be reached.');
      }

      if (response.stop_reason === 'refusal') throw new TriageError('REFUSED', 'The AI service declined to answer.');
      if (response.stop_reason === 'max_tokens') throw new TriageError('TRUNCATED', 'The AI answer was cut off.');

      return {
        // null when the answer did not match the schema; the validator turns that into a rejection
        suggestion: response.parsed_output ?? null,
        usage: response.usage ? { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens } : null,
      };
    },
  };
}
