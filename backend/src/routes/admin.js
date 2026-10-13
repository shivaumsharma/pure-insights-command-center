import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { badRequest, notFound } from '../lib/errors.js';
import { EMAIL_PATTERN, paginate, parsePage, parseSearch, REPORT_ID_PATTERN } from '../lib/validate.js';

export function adminRoutes({ store }) {
  const router = Router();
  const admin = requireRole('admin');

  // Reports with no owner right now, most expensive first (unowned spend is the point of this view).
  router.get('/orphans', admin, (req, res) => {
    const page = parsePage(req.query);
    const rows = store
      .summaries()
      .filter((s) => s.is_orphaned)
      .map((s) => ({ ...s, cost: store.costFields(s.report_id) }))
      .sort((a, b) => (b.cost?.total_cost_usd ?? -1) - (a.cost?.total_cost_usd ?? -1) || (a.report_id < b.report_id ? -1 : 1));
    const orphanedSpend = rows.reduce((sum, r) => sum + (r.cost?.total_cost_usd ?? 0), 0);
    res.json({
      ...paginate(rows, page),
      meta: { ...store.costMeta(), orphaned_spend_usd: Math.round(orphanedSpend * 100) / 100 },
    });
  });

  function reportOr404(req) {
    const id = req.params.id;
    if (!REPORT_ID_PATTERN.test(id)) throw badRequest('report id is not valid');
    if (!store.reportExists(id)) throw notFound('Report not found');
    return id;
  }

  router.put('/reports/:id/owner', admin, (req, res) => {
    const id = reportOr404(req);
    const email = req.body?.email;
    if (typeof email !== 'string') throw badRequest('email is required');
    const clean = email.trim().toLowerCase();
    if (clean.length > 254 || !EMAIL_PATTERN.test(clean)) throw badRequest('email is not valid');
    res.json({ data: store.assign(id, clean, req.user.email) });
  });

  // Removing an assignment returns the report to whatever owner its latest observation shows.
  router.delete('/reports/:id/owner', admin, (req, res) => {
    const id = reportOr404(req);
    res.json({ data: store.unassign(id, req.user.email) });
  });

  router.get('/quarantine', admin, (req, res) => {
    const page = parsePage(req.query);
    const reason = parseSearch(req.query, 'reason');
    const rows = store.quarantine().filter((r) => !reason || r.reason_codes.toLowerCase().includes(reason));
    res.json(paginate(rows, page));
  });

  router.get('/dq-report', admin, (req, res) => res.json({ data: store.dqReport() }));

  router.get('/audit', admin, (req, res) => res.json(paginate(store.audit(), parsePage(req.query))));

  return router;
}
