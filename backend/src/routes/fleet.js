import { Router } from 'express';
import { badRequest, notFound } from '../lib/errors.js';
import { paginate, parseBoolean, parseEnum, parsePage, parseSearch, REPORT_ID_PATTERN } from '../lib/validate.js';
import { canSeeCosts, scopeFor } from './access.js';

const STATUSES = ['SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'];
const SORTS = {
  report_id: { key: (r) => r.report_id, dir: 'asc' },
  latency: { key: (r) => r.latest_load_time_sec ?? -1, dir: 'desc' },
  failures: { key: (r) => r.failed_refresh_count, dir: 'desc' },
  breaches: { key: (r) => r.latency_breach_count, dir: 'desc' },
  cost: { key: (r) => r.cost?.total_cost_usd ?? -1, dir: 'desc', needsCost: true },
};

export function fleetRoutes({ store }) {
  const router = Router();

  router.get('/health', (req, res) => {
    const scope = req.user.role === 'owner' ? 'owned' : 'fleet';
    res.json({ scope, ...store.health(scopeFor(req.user)) });
  });

  router.get('/reports', (req, res) => {
    const status = parseEnum(req.query, 'status', STATUSES);
    const orphaned = parseBoolean(req.query, 'orphaned');
    const search = parseSearch(req.query, 'q');
    const allowedSorts = Object.entries(SORTS).filter(([, s]) => !s.needsCost || canSeeCosts(req.user)).map(([k]) => k);
    const sortName = parseEnum(req.query, 'sort', allowedSorts) ?? 'report_id';
    const order = parseEnum(req.query, 'order', ['asc', 'desc']) ?? SORTS[sortName].dir;
    const page = parsePage(req.query);

    const withCost = canSeeCosts(req.user);
    let rows = store.summaries().filter(scopeFor(req.user));
    if (status) rows = rows.filter((r) => r.last_refresh_status === status);
    if (orphaned !== undefined) rows = rows.filter((r) => r.is_orphaned === orphaned);
    if (search) rows = rows.filter((r) => r.report_id.toLowerCase().includes(search) || (r.report_name ?? '').toLowerCase().includes(search));
    if (withCost) rows = rows.map((r) => ({ ...r, cost: store.costFields(r.report_id) }));

    const { key } = SORTS[sortName];
    const sign = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka !== kb) return (ka < kb ? -1 : 1) * sign;
      return a.report_id < b.report_id ? -1 : 1; // ties: always report_id ascending, whatever the sort direction
    });

    const body = paginate(rows, page);
    if (withCost) body.meta = store.costMeta();
    res.json(body);
  });

  router.get('/reports/:id', (req, res) => {
    const id = req.params.id;
    if (!REPORT_ID_PATTERN.test(id)) throw badRequest('report id is not valid');
    const detail = store.detail(id);
    // 404 (not 403) for someone else's report, so the existence of a report is not leaked.
    if (!detail || !scopeFor(req.user)(detail)) throw notFound('Report not found');
    if (canSeeCosts(req.user)) {
      detail.cost = store.costFields(id);
      res.json({ data: detail, meta: store.costMeta() });
    } else {
      res.json({ data: detail });
    }
  });

  return router;
}
