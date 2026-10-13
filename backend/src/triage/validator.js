// The gate between a suggestion and a person. It never asks whether a suggestion sounds right; it checks it against the evidence.
//
//   REJECTED      something is false or fabricated: a citation that does not exist or states the wrong value, a cause the data
//                 contradicts, an invented kind, or text that looks like markup or an injected instruction. Never shown to users.
//   NEEDS_REVIEW  nothing is false, but it cannot be fully verified or is too sure of itself: an untestable cause, a claim without a
//                 relevant citation, a number the evidence does not contain, overconfidence, or the suggestion asking for a person.
//   TRUSTED       every citation matches, every cause passes its rule against the data, every number is traceable. Shown with its evidence.
//
// "TRUSTED" means "checked against this evidence", not "correct about the real world". The evidence is what the data shows, nothing more.

import { numbersInEvidence } from './evidence.js';
import { ACTION_REQUIRES, CAUSE_RULES } from './rules.js';
import { SuggestionSchema } from './schema.js';

const SUSPICIOUS = /https?:\/\/|www\.|<\/?[a-z!][^>]*>|\[[^\]]*\]\([^)]*\)|[\w.+-]+@[\w-]+\.[\w.-]+|ignore (all |any |the )?(previous|prior|above)|system prompt|\bassistant:|\binstructions?:/i;
const NUMBER = /(?<![\w.])-?\d+(?:\.\d+)?(?!\w)/g;
const MAX_SUMMARY = 400;
const MAX_LINE = 300;
const SMALL_COUNT_LIMIT = 12; // counts like "3 of the latest 5 readings" are derived from the evidence, not copied from one field

export const STATUS = { TRUSTED: 'TRUSTED', NEEDS_REVIEW: 'NEEDS_REVIEW', REJECTED: 'REJECTED' };

function sameValue(actual, claimed) {
  if (typeof actual === 'number') {
    const n = Number(claimed);
    return claimed.trim() !== '' && Number.isFinite(n) && Math.abs(n - actual) < 0.0005;
  }
  return String(actual) === claimed;
}

export function validateSuggestion(raw, evidence) {
  const findings = [];
  const seen = new Set();
  const add = (code, severity, message, where) => {
    const key = `${code}|${where ?? ''}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ code, severity, message, ...(where ? { where } : {}) });
  };
  const result = (suggestion, supported = new Set()) => {
    const status = findings.some((f) => f.severity === 'error') ? STATUS.REJECTED : findings.some((f) => f.severity === 'review') ? STATUS.NEEDS_REVIEW : STATUS.TRUSTED;
    return { status, findings, supported_causes: [...supported], suggestion };
  };

  const parsed = SuggestionSchema.safeParse(raw);
  if (!parsed.success) {
    add('SCHEMA_INVALID', 'error', `The suggestion does not match the required shape (${parsed.error.issues[0]?.path.join('.') || 'root'}: ${parsed.error.issues[0]?.message ?? 'invalid'}).`);
    return result(null);
  }
  const s = parsed.data;

  const checkCites = (cites, where) => {
    cites.forEach((c, i) => {
      const at = `${where}.cites[${i}]`;
      const item = evidence.items[c.evidence];
      if (!item) return add('UNKNOWN_EVIDENCE', 'error', `Cites "${c.evidence}", which is not in the evidence. This is fabricated.`, at);
      if (!(c.field in item.fields)) return add('UNKNOWN_FIELD', 'error', `Cites ${c.evidence}.${c.field}, which does not exist.`, at);
      if (!sameValue(item.fields[c.field], c.value)) {
        add('VALUE_MISMATCH', 'error', `Says ${c.evidence}.${c.field} is "${c.value}" but the data says "${item.fields[c.field]}".`, at);
      }
    });
  };

  const confidenceOk = (value, where) => {
    if (!(value >= 0 && value <= 1)) {
      add('CONFIDENCE_OUT_OF_RANGE', 'error', `Confidence ${value} is outside 0 to 1.`, where);
      return false;
    }
    return true;
  };

  // ---- free text: nothing that looks like markup, a link, an address or an injected instruction ----
  const texts = [['summary', s.summary], ...s.causes.map((c, i) => [`causes[${i}].claim`, c.claim]), ...s.actions.map((a, i) => [`actions[${i}].rationale`, a.rationale])];
  for (const [where, text] of texts) {
    if (SUSPICIOUS.test(text)) add('SUSPICIOUS_TEXT', 'error', 'Contains a link, markup, an email address or what looks like an instruction. Free text may only explain.', where);
    if (text.length > (where === 'summary' ? MAX_SUMMARY : MAX_LINE)) add('TOO_LONG', 'review', 'Longer than the limit for a short explanation.', where);
  }

  // ---- causes ----
  const supported = new Set();
  s.causes.forEach((c, i) => {
    const where = `causes[${i}]`;
    checkCites(c.cites, where);
    confidenceOk(c.confidence, `${where}.confidence`);
    const rule = CAUSE_RULES[c.kind];

    if (c.kind === 'OTHER') {
      add('OTHER_UNVERIFIABLE', 'review', 'This cause cannot be checked against the data, so a person must judge it.', where);
      if (c.confidence > 0.5) add('OVERCONFIDENT', 'review', `Confidence ${c.confidence} is high for a cause the data cannot confirm.`, where);
      return;
    }
    const verdict = rule.verdict(evidence);
    if (verdict === false) {
      add('CAUSE_CONTRADICTED', 'error', `Claims ${c.kind}, but the data does not support it: that requires ${rule.describe}.`, where);
    } else if (verdict === null) {
      add('EVIDENCE_MISSING', 'review', `Cannot check ${c.kind}: the evidence needed (${rule.requires.map((r) => r.join('.')).join(', ')}) is not available.`, where);
    } else {
      supported.add(c.kind);
      if (c.cites.length === 0) add('NO_CITATION', 'review', 'A claim with no citation cannot be traced to the data.', where);
      else if (!rule.requires.some(([id, name]) => c.cites.some((x) => x.evidence === id && x.field === name))) {
        add('NO_RELEVANT_CITATION', 'review', `True, but it does not cite the fields that show it (${rule.requires.map((r) => r.join('.')).join(', ')}).`, where);
      }
    }
  });

  // ---- actions: only offered when the cause that justifies them is supported ----
  s.actions.forEach((a, i) => {
    const where = `actions[${i}]`;
    checkCites(a.cites, where);
    if (!ACTION_REQUIRES[a.kind](supported, evidence)) {
      add('ACTION_UNSUPPORTED', 'review', `${a.kind} is suggested, but no supported cause justifies it.`, where);
    }
  });

  // ---- numbers in the prose must exist in the evidence ----
  const known = numbersInEvidence(evidence);
  const allowed = new Set([...known, ...[...known].flatMap((n) => [Math.round(n), Number(n.toFixed(1))])]);
  const unknown = new Set();
  for (const [, text] of texts) {
    for (const match of text.matchAll(NUMBER)) {
      const n = Number(match[0]);
      const isSmallCount = Number.isInteger(n) && n >= 0 && n <= SMALL_COUNT_LIMIT;
      if (!allowed.has(n) && !isSmallCount) unknown.add(match[0]);
    }
  }
  if (unknown.size > 0) add('UNSUPPORTED_NUMBER', 'review', `Uses numbers that are not in the evidence: ${[...unknown].join(', ')}.`, 'text');

  // ---- overall confidence and the explicit human gate ----
  if (confidenceOk(s.confidence, 'confidence')) {
    const everythingChecked = s.causes.length > 0 && s.causes.every((c) => c.kind !== 'OTHER' && supported.has(c.kind));
    if (s.confidence > 0.7 && !everythingChecked) add('OVERCONFIDENT', 'review', `Confidence ${s.confidence} is high but not every cause is confirmed by the data.`, 'confidence');
    if (s.confidence > 0.95) add('OVERCONFIDENT', 'review', 'Near-certainty is not justified from this much evidence.', 'confidence');
    if (s.confidence < 0.4) add('LOW_CONFIDENCE', 'review', `Overall confidence is only ${s.confidence}.`, 'confidence');
  }
  if (s.needs_human) add('HUMAN_REQUESTED', 'review', 'The suggestion itself says the evidence does not support a confident explanation.', 'needs_human');
  if (s.causes.length === 0 && !s.needs_human) add('NO_EXPLANATION', 'review', 'No cause was given and a person was not requested.', 'causes');

  return result(s, supported);
}
