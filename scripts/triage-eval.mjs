// Measures the AI triage feature honestly.
//
//   npm run triage:eval                         offline: the validator against a corpus of hallucinations, and the rule-based triager
//   npm run triage:eval -- --llm --limit 20     ALSO runs a hosted model (Claude) on 20 alerts (needs ANTHROPIC_API_KEY; asks for --yes before spending)
//   npm run triage:eval -- --llm --provider ollama --limit 10
//                                               ALSO runs a model on this computer through Ollama: free, no key, nothing leaves the machine.
//                                               Optional: --model qwen2.5:7b (or AI_MODEL), OLLAMA_HOST. Slow on a laptop: about a minute per alert.
//
// What each part tells you, and what it does not:
//   Corpus     Does the validator catch deliberate mistakes? These were written to be caught, so a perfect score shows the validator works
//              on the cases I thought of, not on every way a model can be wrong.
//   Rules      The control. Every alert is explained by the rule-based triager and judged by the same validator.
//   Live model Only this part says anything about a real model. It is a small sample of a synthetic data set: it measures whether the
//              model reads the evidence correctly, not whether its explanations are right about any real system.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAlertEngine } from '../backend/src/alerts/engine.js';
import { DEFAULT_OUT } from '../backend/src/pipeline/pipeline.js';
import { loadStore } from '../backend/src/store.js';
import { baselineTriager } from '../backend/src/triage/baseline.js';
import { buildEvidence } from '../backend/src/triage/evidence.js';
import { TriageError, createLlmTriager } from '../backend/src/triage/llm.js';
import { DEFAULT_OLLAMA_MODEL, createOllamaTriager, isLocalHost, normaliseOllamaHost } from '../backend/src/triage/ollama.js';
import { validateSuggestion } from '../backend/src/triage/validator.js';
import { HALLUCINATIONS, mutate } from '../backend/test/helpers/triage-corpus.js';
import { good, pack } from '../backend/test/helpers/triage-fixtures.js';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const pct = (n, d) => (d === 0 ? '0%' : `${Math.round((100 * n) / d)}%`);
const tally = (rows, key) => rows.reduce((acc, r) => { acc[key(r)] = (acc[key(r)] ?? 0) + 1; return acc; }, {});

console.log('=== 1. Validator vs a corpus of hallucinations ===');
const evidence = pack();
let caught = 0;
const missed = [];
for (const [name, breakIt, status, code] of HALLUCINATIONS) {
  const r = validateSuggestion(mutate(breakIt), evidence);
  if (r.status === status && r.findings.some((f) => f.code === code)) caught++;
  else missed.push(`${name} (expected ${status}/${code}, got ${r.status}/${r.findings.map((f) => f.code).join(',') || 'nothing'})`);
}
const goodVerdict = validateSuggestion(good(), evidence);
console.log(`caught with the right verdict and reason: ${caught} of ${HALLUCINATIONS.length} (${pct(caught, HALLUCINATIONS.length)})`);
console.log(`a true, fully cited suggestion is wrongly flagged: ${goodVerdict.status === 'TRUSTED' ? 'no' : 'YES: ' + goodVerdict.findings.map((f) => f.code).join(',')}`);
for (const m of missed) console.log(`  MISSED: ${m}`);

console.log('\n=== 2. The rule-based triager (the control) on every explainable real alert ===');
const store = loadStore({ dataDir: DEFAULT_OUT, runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pi-eval-')) });
const engine = createAlertEngine();
const alerts = [];
for (const o of store.observations()) alerts.push(...engine.process(o));
const explainable = alerts.filter((a) => a.lifecycle !== 'RESOLVED');
const control = [];
for (const alert of explainable) {
  const ev = buildEvidence({ alert, store });
  const { suggestion } = await baselineTriager.triage(ev);
  control.push({ alert, ev, verdict: validateSuggestion(suggestion, ev), causes: suggestion.causes.map((c) => c.kind) });
}
const byStatus = tally(control, (r) => r.verdict.status);
console.log(`alerts: ${alerts.length} (${explainable.length} explainable, the rest are resolutions)`);
console.log(`verdicts: ${JSON.stringify(byStatus)}`);
console.log(`with a data-supported cause: ${control.filter((r) => r.causes.length > 0).length} (${pct(control.filter((r) => r.causes.length > 0).length, control.length)}); the rest are honestly sent to a person`);
console.log(`causes found: ${JSON.stringify(tally(control.flatMap((r) => r.causes), (k) => k))}`);

if (!flag('--llm')) {
  console.log('\n(No live model run. Add --llm to try one: --provider ollama is free and local; the default, Claude, needs a key and costs money.)');
  process.exit(missed.length === 0 && goodVerdict.status === 'TRUSTED' ? 0 : 1);
}

// ------------------------------------------------------------------ live model
const provider = value('--provider', 'anthropic');
if (provider !== 'anthropic' && provider !== 'ollama') {
  console.error(`--provider must be 'anthropic' or 'ollama', not '${provider}'`);
  process.exit(2);
}
const limit = Math.min(Math.max(Number(value('--limit', 20)), 1), 100);
const stride = Math.max(1, Math.floor(control.length / limit));
const sample = control.filter((_, i) => i % stride === 0).slice(0, limit); // evenly spread over the stream, not just the first alerts
const model = value('--model', process.env.AI_MODEL ?? (provider === 'ollama' ? DEFAULT_OLLAMA_MODEL : 'claude-opus-5-5'));
const ollamaHost = provider === 'ollama' ? normaliseOllamaHost(process.env.OLLAMA_HOST) : null;
const staysHere = provider === 'ollama' && isLocalHost(ollamaHost);

console.log(`\n=== 3. LIVE MODEL: ${model} (${provider === 'ollama' ? `local, via Ollama at ${ollamaHost}` : 'hosted by Anthropic'}) on ${sample.length} alerts ===`);
console.log('What is sent per request: the evidence pack only (report id, a few numeric readings, fleet baselines) plus the instructions.');
console.log(`Never sent: owner emails, report names, cost data${provider === 'anthropic' ? ', or your API key' : ''}.`);
console.log(staysHere ? 'It goes to a process on this computer and stays here. No cost, no key.' : `It leaves this computer${provider === 'ollama' ? `, for ${ollamaHost}` : ' and goes to the provider'}.`);
console.log('Example evidence pack:\n' + JSON.stringify(Object.fromEntries(Object.entries(sample[0].ev.items).slice(0, 4).map(([k, v]) => [k, v.fields])), null, 2));
if (!staysHere && !flag('--yes')) {
  console.log(`\nThis would send ${sample.length} requests${provider === 'anthropic' ? ' (paid API calls)' : ''} off this computer. Re-run with --yes to proceed.`);
  process.exit(0);
}

const llm = provider === 'ollama' ? createOllamaTriager({ host: ollamaHost, model, timeoutMs: 300_000 }) : createLlmTriager({ model });
const live = [];
let inTokens = 0, outTokens = 0;
for (const [i, row] of sample.entries()) {
  const t0 = Date.now();
  try {
    const out = await llm.triage(row.ev);
    inTokens += out.usage?.input_tokens ?? 0;
    outTokens += out.usage?.output_tokens ?? 0;
    live.push({ ...row, error: null, ms: Date.now() - t0, verdict: validateSuggestion(out.suggestion, row.ev) });
  } catch (err) {
    live.push({ ...row, error: err instanceof TriageError ? err.code : 'ERROR', ms: Date.now() - t0, verdict: null });
  }
  const last = live.at(-1);
  process.stdout.write(provider === 'ollama' ? `  ${i + 1}/${sample.length}  ${Math.round(last.ms / 1000)}s  ${last.error ?? last.verdict.status}\n` : '.');
}
console.log('\n');

const answered = live.filter((r) => r.verdict);
const failedCalls = live.filter((r) => r.error);
console.log(`calls that failed: ${failedCalls.length} ${JSON.stringify(tally(failedCalls, (r) => r.error))}`);
console.log(`model verdicts (n=${answered.length}):   ${JSON.stringify(tally(answered, (r) => r.verdict.status))}`);
console.log(`rules, same alerts (n=${sample.length}):  ${JSON.stringify(tally(sample, (r) => r.verdict.status))}`);
console.log(`why the model was held or rejected: ${JSON.stringify(tally(answered.flatMap((r) => [...new Set(r.verdict.findings.map((f) => f.code))]), (c) => c))}`);
console.log(`model confirmed the same alerts the rules explained: ${answered.filter((r) => r.verdict.status === 'TRUSTED' && r.causes.length > 0).length} of ${answered.filter((r) => r.causes.length > 0).length}`);
console.log(`tokens: ${inTokens} in, ${outTokens} out. Median latency ${[...live.map((r) => r.ms)].sort((a, b) => a - b)[Math.floor(live.length / 2)]} ms.`);
if (provider === 'anthropic') console.log(`rough cost at ${model}'s list price in this repo's notes ($4 in / $20 out per million tokens; verify current pricing): $${((inTokens * 4 + outTokens * 20) / 1e6).toFixed(3)}`);
else console.log('cost: none (a model running on this computer).');

const outFile = path.join(path.resolve(import.meta.dirname, '..'), `data/runtime/triage-eval-live-${provider}-${model.replace(/[^a-z0-9.-]+/gi, '_')}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ provider, model, n: sample.length, model_verdicts: tally(answered, (r) => r.verdict.status), rules_verdicts: tally(sample, (r) => r.verdict.status), errors: tally(failedCalls, (r) => r.error), tokens: { in: inTokens, out: outTokens } }, null, 2));
console.log(`saved a summary to ${path.relative(process.cwd(), outFile)} (not committed: data/runtime is ignored)`);
