import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { badRequest } from '../lib/errors.js';
import { parseEnum } from '../lib/validate.js';

const MAX_NOTE = 500;

function eventId(raw) {
  if (!/^\d{1,9}$/.test(raw)) throw badRequest('event id must be a whole number');
  return Number(raw);
}

export function triageRoutes({ triage }) {
  const router = Router();

  // Explain one alert. Any role that can see the alert may ask; what comes back depends on the role and on whether the suggestion
  // passed validation (see triage/service.js). Cached per alert, so asking again is free and always gives the same answer.
  router.get('/alerts/:eventId/triage', async (req, res) => {
    res.json({ data: await triage.get(eventId(req.params.eventId), req.user) });
  });

  // Suggestions held for a person, newest first.
  router.get('/triage/review', requireRole('admin'), (req, res) => {
    const state = parseEnum(req.query, 'state', ['pending', 'approved', 'dismissed', 'all']) ?? 'pending';
    res.json({ data: triage.listReview({ state }) });
  });

  router.post('/triage/:eventId/review', requireRole('admin'), (req, res) => {
    const id = eventId(req.params.eventId);
    const { decision, note } = req.body ?? {};
    if (decision !== 'approve' && decision !== 'dismiss') throw badRequest("decision must be 'approve' or 'dismiss'");
    if (note !== undefined && (typeof note !== 'string' || note.length > MAX_NOTE)) throw badRequest(`note must be text of at most ${MAX_NOTE} characters`);
    res.json({ data: triage.review({ eventId: id, decision, note: note?.trim() || undefined, actor: req.user.email }) });
  });

  // Verdict counts, why suggestions were held, and the AI against the rule-based control.
  router.get('/triage/stats', requireRole('admin'), (req, res) => res.json({ data: triage.stats() }));

  return router;
}
