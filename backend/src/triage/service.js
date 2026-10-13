// Orchestrates one triage: evidence -> triager (AI or rules) -> validator -> a result that is shown, held for review, or withheld.
//
// Who sees what (decision D33):
//   TRUSTED        everyone who can see the alert gets the suggestion and the evidence behind it
//   NEEDS_REVIEW   held. Admins see it in the review queue; everyone else is told it is under review. An admin can approve it
//   REJECTED       withheld (something in it is false or fabricated). Only admins see it, and they can only dismiss it
//
// Results are cached per alert, so asking twice costs nothing and a person can never get two different answers to the same question.
// Review decisions are the only thing persisted (data/runtime/triage.json); the data itself is never modified.

import fs from 'node:fs';
import path from 'node:path';
import { HttpError, badRequest, notFound } from '../lib/errors.js';
import { baselineTriager } from './baseline.js';
import { buildEvidence } from './evidence.js';
import { TriageError } from './llm.js';
import { STATUS, validateSuggestion } from './validator.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function createTriageService({
  store, alerts, aiTriager = null, runtimeDir, now = () => new Date(),
  maxGenerationsPerMinute = 10, maxModelCallsPerHour = 60, failureTtlMs = MINUTE, logger = console,
}) {
  const stateFile = path.join(runtimeDir, 'triage.json');
  let results = {}; // event_id -> result
  if (fs.existsSync(stateFile)) {
    try {
      results = JSON.parse(fs.readFileSync(stateFile, 'utf8')).results ?? {};
    } catch (err) {
      throw new Error(`${stateFile} is not valid JSON; fix or delete it (${err.message})`);
    }
  }
  const persist = () => {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const tmp = `${stateFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ results }, null, 2));
    fs.renameSync(tmp, stateFile);
  };

  const inflight = new Map(); // event_id -> promise, so concurrent requests share one generation
  const generations = new Map(); // user email -> timestamps (rate limit)
  const modelCalls = []; // timestamps of calls to the AI (budget)
  const counters = { fallbacks: 0, tokens_in: 0, tokens_out: 0, model_calls: 0 };

  function checkRate(email) {
    const cutoff = now().getTime() - MINUTE;
    const recent = (generations.get(email) ?? []).filter((t) => t > cutoff);
    if (recent.length >= maxGenerationsPerMinute) throw new HttpError(429, 'RATE_LIMITED', 'Too many explanations requested. Wait a moment and try again.');
    generations.set(email, [...recent, now().getTime()]);
  }

  function modelBudgetLeft() {
    const cutoff = now().getTime() - HOUR;
    while (modelCalls.length > 0 && modelCalls[0] <= cutoff) modelCalls.shift();
    return modelCalls.length < maxModelCallsPerHour;
  }

  async function generate(alert) {
    const evidence = buildEvidence({ alert, store });
    let triager = baselineTriager;
    let fallback = null;
    if (aiTriager) {
      if (modelBudgetLeft()) triager = aiTriager;
      else fallback = { from: aiTriager.name, reason: 'BUDGET' };
    }

    let produced;
    try {
      if (triager === aiTriager) { modelCalls.push(now().getTime()); counters.model_calls++; }
      produced = await triager.triage(evidence);
    } catch (err) {
      if (triager === baselineTriager) throw err;
      // The AI failed (timeout, refusal, outage): fall back to the rule-based triager rather than leaving the person with nothing.
      if (!(err instanceof TriageError)) logger.error?.('Unexpected AI triage error:', err);
      fallback = { from: triager.name, reason: err instanceof TriageError ? err.code : 'ERROR' };
      triager = baselineTriager;
      produced = await baselineTriager.triage(evidence);
    }
    if (fallback) counters.fallbacks++;
    if (produced.usage) { counters.tokens_in += produced.usage.input_tokens; counters.tokens_out += produced.usage.output_tokens; }

    const verdict = validateSuggestion(produced.suggestion, evidence);
    // When an AI produced this, also record how the rule-based control would have fared, for the measurement page.
    let baselineStatus = null;
    if (triager === aiTriager) {
      const control = await baselineTriager.triage(evidence);
      baselineStatus = validateSuggestion(control.suggestion, evidence).status;
    }

    return {
      id: `T-${alert.event_id}`,
      event_id: alert.event_id,
      report_id: alert.report_id,
      alert_type: alert.alert_type,
      alert_severity: alert.severity,
      triager: triager.name,
      model: triager.model ?? null,
      status: verdict.status,
      findings: verdict.findings,
      suggestion: verdict.suggestion, // the validated, parsed form (null when it did not match the shape)
      evidence: { items: evidence.items, order: evidence.order },
      usage: produced.usage,
      fallback,
      baseline_status: baselineStatus,
      created_at: now().toISOString(),
      review: { state: verdict.status === STATUS.TRUSTED ? 'none' : 'pending', by: null, at: null, note: null },
    };
  }

  const isShown = (r) => r.status === STATUS.TRUSTED || r.review.state === 'approved';

  function view(user, r) {
    const admin = user.role === 'admin';
    const shown = isShown(r);
    const status = shown
      ? r.review.state === 'approved' ? 'APPROVED' : 'TRUSTED'
      : r.review.state === 'dismissed' ? 'DISMISSED' : r.status === STATUS.REJECTED ? 'WITHHELD' : 'UNDER_REVIEW';
    const out = { id: r.id, event_id: r.event_id, report_id: r.report_id, status, triager: r.triager, model: r.model, created_at: r.created_at };
    if (r.fallback) out.fallback = { from: r.fallback.from };
    if (shown || admin) {
      out.suggestion = r.suggestion;
      out.evidence = r.evidence;
    }
    if (admin) {
      out.validation = r.status;
      out.findings = r.findings;
      out.review = r.review;
      out.usage = r.usage;
      out.baseline_validation = r.baseline_status;
    }
    if (!shown && !admin) {
      out.message =
        status === 'UNDER_REVIEW' ? 'A suggestion was produced but could not be fully verified against the data, so a person is checking it first.'
        : status === 'WITHHELD' ? 'A suggestion was produced but it did not match the data, so it was withheld.'
        : 'A person reviewed this suggestion and chose not to show it.';
    }
    if (shown && r.review.state === 'approved') out.reviewed_by_a_person = true;
    return out;
  }

  return {
    // Explain one alert for this user (cached). Throws 404 for an alert they cannot see, 400 for one with nothing to explain.
    async get(eventId, user) {
      const alert = alerts.get(eventId);
      if (!alert || !alerts.visibleTo(user, alert)) throw notFound('Alert not found');
      if (alert.lifecycle === 'RESOLVED') throw badRequest('This alert has resolved, so there is nothing to explain.');

      const key = String(eventId);
      const cached = results[key];
      if (cached) return view(user, cached);

      if (!inflight.has(key)) {
        checkRate(user.email);
        const task = generate(alert)
          .then((r) => { results[key] = r; persist(); return r; })
          .finally(() => inflight.delete(key));
        inflight.set(key, task);
      }
      return view(user, await inflight.get(key));
    },

    // Admin: results waiting for a person (or all that were ever held), newest first.
    listReview({ state = 'pending' } = {}) {
      const rows = Object.values(results).filter((r) => r.review.state !== 'none' && (state === 'all' || r.review.state === state));
      return rows.sort((a, b) => b.event_id - a.event_id).map((r) => view({ role: 'admin' }, r));
    },

    review({ eventId, decision, note, actor }) {
      const r = results[String(eventId)];
      if (!r || r.review.state === 'none') throw notFound('Nothing to review for that alert');
      if (r.review.state !== 'pending') throw new HttpError(409, 'ALREADY_REVIEWED', 'That suggestion has already been reviewed.');
      if (decision === 'approve' && r.status === STATUS.REJECTED) {
        throw new HttpError(409, 'CANNOT_APPROVE', 'This suggestion contradicts the data, so it cannot be approved. Dismiss it instead.');
      }
      r.review = { state: decision === 'approve' ? 'approved' : 'dismissed', by: actor, at: now().toISOString(), note: note ?? null };
      persist();
      return view({ role: 'admin' }, r);
    },

    // How the feature is doing: verdicts, why suggestions were held, and the AI against the rule-based control.
    stats() {
      const all = Object.values(results);
      const tally = (fn) => all.reduce((acc, r) => { const k = fn(r); if (k !== null) acc[k] = (acc[k] ?? 0) + 1; return acc; }, {});
      const byTriager = {};
      for (const r of all) {
        const t = (byTriager[r.triager] ??= { total: 0, TRUSTED: 0, NEEDS_REVIEW: 0, REJECTED: 0 });
        t.total++;
        t[r.status]++;
      }
      const findingCodes = {};
      for (const r of all) for (const code of new Set(r.findings.map((f) => f.code))) findingCodes[code] = (findingCodes[code] ?? 0) + 1;
      const ai = all.filter((r) => r.baseline_status !== null);
      return {
        explained: all.length,
        validation: tally((r) => r.status),
        by_triager: byTriager,
        finding_codes: findingCodes,
        review: tally((r) => (r.review.state === 'none' ? null : r.review.state)),
        ai_vs_rules: {
          compared: ai.length,
          ai_trusted: ai.filter((r) => r.status === STATUS.TRUSTED).length,
          rules_trusted: ai.filter((r) => r.baseline_status === STATUS.TRUSTED).length,
          ai_rejected: ai.filter((r) => r.status === STATUS.REJECTED).length,
        },
        model_calls: counters.model_calls,
        fallbacks: counters.fallbacks,
        tokens: { input: counters.tokens_in, output: counters.tokens_out },
        provider: aiTriager ? { name: aiTriager.name, model: aiTriager.model } : null,
      };
    },
  };
}
