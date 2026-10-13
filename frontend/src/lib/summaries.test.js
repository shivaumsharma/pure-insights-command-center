import { describe, expect, it } from 'vitest';
import { alertFlow, spendBreakdown, topBy } from './summaries.js';

const row = (id, total, extra = {}) => ({ report_id: id, total_cost_usd: total, credit_cost_usd: total * 0.9, aws_cost_usd: total * 0.1, idle_cost_usd: 0, is_orphaned: false, ...extra });

describe('spendBreakdown', () => {
  it('adds up the fleet, splits owned from unowned, and reports the unowned share as a whole percent', () => {
    const s = spendBreakdown([row('A', 1000), row('B', 3000, { is_orphaned: true }), row('C', 6000, { idle_cost_usd: 250 })]);
    expect(s.total).toBe(10000);
    expect(s.unowned).toBe(3000);
    expect(s.owned).toBe(7000);
    expect(s.unownedPct).toBe(30);
    expect(s.idle).toBe(250);
    expect(s.credits + s.hosting).toBeCloseTo(s.total, 6);
    expect(s.reports).toBe(3);
  });
  it('copes with nothing, and with missing numbers', () => {
    expect(spendBreakdown([])).toMatchObject({ total: 0, unowned: 0, owned: 0, unownedPct: 0, reports: 0 });
    const s = spendBreakdown([row('A', null), { report_id: 'B' }]);
    expect(s.total).toBe(0);
    expect(s.unownedPct).toBe(0);
  });
});

describe('topBy', () => {
  it('ranks biggest first, drops zero and missing values, caps the list, and breaks ties by report id', () => {
    const rows = [row('C', 5), row('A', 5), row('B', 9), row('Z', 0), row('Y', null)];
    expect(topBy(rows, 'total_cost_usd', 10).map((r) => r.report_id)).toEqual(['B', 'A', 'C']);
    expect(topBy(rows, 'total_cost_usd', 2).map((r) => r.report_id)).toEqual(['B', 'A']);
  });
  it('does not change the rows it was given', () => {
    const rows = [row('A', 1), row('B', 2)];
    topBy(rows, 'total_cost_usd', 5);
    expect(rows.map((r) => r.report_id)).toEqual(['A', 'B']);
  });
});

describe('alertFlow', () => {
  const summary = {
    observations: 4880,
    breaches: { LATENCY: 3644, REFRESH_FAILURE: 1370 },
    emitted: { TRIGGERED: 1041, ESCALATED: 499, REPEATED: 456, RESOLVED: 903 },
    suppressed: { LATENCY: 2455, REFRESH_FAILURE: 563 },
  };
  it('turns the alert counters into breaches, alerts sent, repeats held back and the share held back', () => {
    const f = alertFlow(summary);
    expect(f.breaches).toBe(5014);
    expect(f.sent).toBe(1996);
    expect(f.held).toBe(3018);
    expect(f.sent + f.held).toBe(f.breaches); // every breach is either an alert or a held-back repeat
    expect(f.heldPct).toBe(60);
    expect(f.resolved).toBe(903);
    expect(f.stages).toEqual({ TRIGGERED: 1041, ESCALATED: 499, REPEATED: 456 });
    expect(f.readings).toBe(4880);
  });
  it('survives an empty summary', () => {
    expect(alertFlow({})).toMatchObject({ breaches: 0, sent: 0, held: 0, resolved: 0, heldPct: 0 });
  });
});
