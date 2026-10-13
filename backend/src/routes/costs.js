import { Router } from 'express';
import { paginate, parseBoolean, parseEnum, parsePage } from '../lib/validate.js';
import { requireRole } from '../auth/middleware.js';

const COST_SORTS = {
  total_cost: (r) => r.total_cost_usd,
  cost_per_view: (r) => r.cost_per_view_usd ?? -1,
  idle_cost: (r) => r.idle_cost_usd,
};

export function costRoutes({ store }) {
  const router = Router();

  // Admin sees every report; an owner sees only the cost of reports they currently own.
  router.get('/costs/reports', requireRole('admin', 'owner'), (req, res) => {
    const orphaned = parseBoolean(req.query, 'orphaned');
    const sortName = parseEnum(req.query, 'sort', Object.keys(COST_SORTS)) ?? 'total_cost';
    const order = parseEnum(req.query, 'order', ['asc', 'desc']) ?? 'desc';
    const page = parsePage(req.query);

    let rows = store.costRows();
    if (req.user.role === 'owner') rows = rows.filter((r) => r.owner_email === req.user.email);
    if (orphaned !== undefined) rows = rows.filter((r) => r.is_orphaned === orphaned);
    const key = COST_SORTS[sortName];
    const sign = order === 'asc' ? 1 : -1;
    rows = rows.map((r) => ({ ...r, is_orphaned: Boolean(r.is_orphaned) }));
    rows.sort((a, b) => {
      if (key(a) !== key(b)) return (key(a) < key(b) ? -1 : 1) * sign;
      return a.report_id < b.report_id ? -1 : 1;
    });

    res.json({ ...paginate(rows, page), meta: store.costMeta() });
  });

  router.get('/costs/reconciliation', requireRole('admin'), (req, res) => {
    const checks = store.checks();
    const summary = { pass: 0, fail: 0, info: 0 };
    for (const c of checks) summary[c.status.toLowerCase()]++;
    res.json({ data: checks, summary, meta: store.costMeta() });
  });

  router.get('/costs/variance', requireRole('admin'), (req, res) => {
    const status = parseEnum(req.query, 'status', ['WITHIN_TOLERANCE', 'OUTSIDE_TOLERANCE']);
    const page = parsePage(req.query);
    const rows = store.variance().filter((r) => !status || r.status === status);
    res.json({ ...paginate(rows, page), meta: store.costMeta() });
  });

  router.get('/costs/aws-mismatch', requireRole('admin'), (req, res) => {
    const type = parseEnum(req.query, 'type', ['COST_HIGH_FOR_USAGE', 'COST_LOW_FOR_USAGE', 'ZERO_VIEWS_WITH_COST']);
    const page = parsePage(req.query);
    const rows = store.awsMismatch().filter((r) => !type || r.mismatch_type === type);
    res.json({ ...paginate(rows, page), meta: store.costMeta() });
  });

  return router;
}
