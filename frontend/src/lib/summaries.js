// The sums and rankings behind the charts, kept out of the components so the arithmetic can be tested on its own.
// Inputs are the API's own rows; nothing here invents a figure.

const num = (v) => (Number.isFinite(v) ? v : 0);
const sum = (rows, key) => rows.reduce((total, r) => total + num(r[key]), 0);

// rows: the rows of GET /api/costs/reports.
export function spendBreakdown(rows) {
  const total = sum(rows, 'total_cost_usd');
  const unowned = rows.filter((r) => r.is_orphaned).reduce((t, r) => t + num(r.total_cost_usd), 0);
  const idle = sum(rows, 'idle_cost_usd');
  return {
    total,
    credits: sum(rows, 'credit_cost_usd'),
    hosting: sum(rows, 'aws_cost_usd'),
    idle,
    unowned,
    owned: total - unowned,
    unownedPct: total > 0 ? Math.round((100 * unowned) / total) : 0,
    reports: rows.length,
  };
}

const byDesc = (key) => (a, b) => num(b[key]) - num(a[key]) || String(a.report_id).localeCompare(String(b.report_id));

export const topBy = (rows, key, n) => [...rows].filter((r) => Number.isFinite(r[key]) && r[key] > 0).sort(byDesc(key)).slice(0, n);

// summary: the `data` of GET /api/alerts/summary (counters since the server started).
// Every breaching reading either became an alert or was held back as a repeat, so sent + held = breaches.
export function alertFlow(summary) {
  const breaches = num(summary.breaches?.LATENCY) + num(summary.breaches?.REFRESH_FAILURE);
  const e = summary.emitted ?? {};
  const sent = num(e.TRIGGERED) + num(e.ESCALATED) + num(e.REPEATED);
  const held = num(summary.suppressed?.LATENCY) + num(summary.suppressed?.REFRESH_FAILURE);
  return {
    breaches,
    sent,
    held,
    resolved: num(e.RESOLVED),
    stages: { TRIGGERED: num(e.TRIGGERED), ESCALATED: num(e.ESCALATED), REPEATED: num(e.REPEATED) },
    heldPct: breaches > 0 ? Math.round((100 * held) / breaches) : 0,
    readings: num(summary.observations),
  };
}
