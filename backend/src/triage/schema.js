// The shape of an AI (or rule-based) triage suggestion. Kept deliberately small and closed: every cause and action is a kind from a
// fixed list that the validator knows how to check against the data. Free text exists only to explain, never to carry facts.
//
// This schema is also what the model is asked to produce (structured outputs), but a response that matches it is NOT trusted:
// matching the shape says nothing about whether the claims are true. The validator (validator.js) does that.

import { z } from 'zod';

export const CAUSE_KINDS = ['HIGH_QUERY_VOLUME', 'HIGH_CONCURRENCY', 'RECURRING_SLOWNESS', 'REPEATED_FAILURES', 'OWNERSHIP_GAP', 'OTHER'];
export const ACTION_KINDS = ['INVESTIGATE_QUERIES', 'REVIEW_CAPACITY', 'CHECK_REFRESH_SCHEDULE', 'ASSIGN_OWNER', 'MONITOR', 'NONE'];

// A citation points at one field of one evidence item and states the value the claimant read there. All values are strings so the
// schema stays simple for structured outputs; the validator compares them numerically where the field is numeric.
const Cite = z.object({
  evidence: z.string().describe('The id of an evidence item, such as "O1" or "F"'),
  field: z.string().describe('A field name inside that evidence item'),
  value: z.string().describe('The value you read in that field, copied exactly'),
});

const Cause = z.object({
  kind: z.enum(CAUSE_KINDS),
  claim: z.string().describe('One short sentence. Use only numbers that appear in the evidence.'),
  cites: z.array(Cite).describe('The evidence fields that support this claim'),
  confidence: z.number().describe('0 to 1: how well the cited evidence supports this cause'),
});

const Action = z.object({
  kind: z.enum(ACTION_KINDS),
  rationale: z.string().describe('One short sentence'),
  cites: z.array(Cite),
});

export const SuggestionSchema = z.object({
  summary: z.string().describe('Two sentences at most, in plain words, using only facts from the evidence'),
  causes: z.array(Cause),
  actions: z.array(Action),
  needs_human: z.boolean().describe('True when the evidence does not support a confident explanation'),
  confidence: z.number().describe('0 to 1 overall'),
});
