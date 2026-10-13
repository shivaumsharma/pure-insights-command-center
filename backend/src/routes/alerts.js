import { Router } from 'express';
import { requireRole } from '../auth/middleware.js';
import { ALERT_TYPES, LIFECYCLES, SEVERITY_RANK } from '../alerts/rules.js';
import { paginate, parseEnum, parsePage, single, REPORT_ID_PATTERN } from '../lib/validate.js';
import { badRequest } from '../lib/errors.js';

export function alertRoutes({ alerts }) {
  const router = Router();

  // Alert history, newest first. Owners only see alerts for reports they own. The WebSocket pushes the same objects live.
  router.get('/alerts', (req, res) => {
    const alertType = parseEnum(req.query, 'alert_type', ALERT_TYPES);
    const severity = parseEnum(req.query, 'severity', Object.keys(SEVERITY_RANK));
    const lifecycle = parseEnum(req.query, 'lifecycle', LIFECYCLES);
    const reportId = single(req.query, 'report_id');
    if (reportId !== undefined && !REPORT_ID_PATTERN.test(reportId)) throw badRequest('report_id is not valid');
    const page = parsePage(req.query);
    const rows = alerts.list(req.user, { alertType, severity, lifecycle, reportId });
    res.json({ ...paginate(rows, page), meta: { last_event_id: alerts.lastEventId(), oldest_event_id: alerts.oldestEventId() } });
  });

  // Conditions that are true right now (triggered and not yet resolved).
  router.get('/alerts/active', (req, res) => {
    const rows = alerts.active(req.user).sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (a.report_id < b.report_id ? -1 : 1));
    // Counts over everything the caller may see (not just this page), so a dashboard can show them without downloading every row.
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const r of rows) bySeverity[r.severity]++;
    res.json({ ...paginate(rows, parsePage(req.query)), meta: { last_event_id: alerts.lastEventId(), by_severity: bySeverity } });
  });

  // How well the de-duplication is working: readings in, alerts out, readings held back.
  router.get('/alerts/summary', requireRole('admin'), (req, res) => res.json({ data: alerts.stats() }));

  return router;
}
