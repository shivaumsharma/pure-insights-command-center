import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alert, baseRoutes, page, renderApp } from './test/harness.jsx';

const evidence = {
  items: {
    O1: { label: 'The reading that raised the alert', fields: { query_count_last_30d: 21000 } },
    F: { label: 'Fleet-wide baselines', fields: { p75_query_count_last_30d: 18898 } },
  },
  order: ['O1', 'F'],
};
const suggestion = {
  summary: 'Load time on RPT_201 was 41.2 s against the 15 s limit. The data supports one possible cause.',
  causes: [{ kind: 'HIGH_QUERY_VOLUME', claim: "The latest reading had 21000 queries, at or above the fleet's busiest quarter (18898).", confidence: 0.8, cites: [{ evidence: 'O1', field: 'query_count_last_30d', value: '21000' }, { evidence: 'F', field: 'p75_query_count_last_30d', value: '18898' }] }],
  actions: [{ kind: 'INVESTIGATE_QUERIES', rationale: 'Query volume is among the highest in the fleet.', cites: [{ evidence: 'O1', field: 'query_count_last_30d', value: '21000' }] }],
  needs_human: false,
  confidence: 0.8,
};
const view = (extra = {}) => ({ id: 'T-1', event_id: 1, report_id: 'RPT_201', status: 'TRUSTED', triager: 'baseline', model: null, created_at: '2026-10-12T10:00:00.000Z', suggestion, evidence, ...extra });

const alertsRoutes = (triageResponse) => ({
  ...baseRoutes,
  'GET /api/alerts': { ...page([alert(1), alert(2, { lifecycle: 'RESOLVED', message: 'RPT_201 is back under 15 s' })]), meta: { last_event_id: 2, oldest_event_id: 1 } },
  'GET /api/alerts/1/triage': triageResponse,
});
const openExplain = async () => {
  const history = await screen.findByRole('list', { name: 'Alert history' });
  await userEvent.click(within(history).getByRole('button', { name: /Explain alert 1/ }));
  return history;
};

describe('Explain this alert', () => {
  it('only open alerts can be explained; a resolved one has no button', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view() }) });
    const history = await screen.findByRole('list', { name: 'Alert history' });
    expect(within(history).getAllByRole('button', { name: /Explain alert/ })).toHaveLength(1);
    expect(within(history).queryByRole('button', { name: /alert 2/ })).toBeNull();
  });

  it('loads only when opened, shows the suggestion with the evidence behind every claim, and says it is not automatic', async () => {
    const { fetchImpl } = renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view() }) });
    await screen.findByRole('list', { name: 'Alert history' });
    expect(fetchImpl.callsTo('GET', '/api/alerts/1/triage')).toHaveLength(0); // nothing is generated until someone asks

    const history = await openExplain();
    expect(await within(history).findByText('Checked against the data')).toBeInTheDocument();
    expect(within(history).getByText('Rule-based explanation. No AI was used.')).toBeInTheDocument();
    expect(within(history).getByText('High query volume')).toBeInTheDocument();
    expect(within(history).getByText(/80% sure/)).toBeInTheDocument();
    expect(within(history).getAllByText('O1 · query_count_last_30d = 21000').length).toBeGreaterThan(0);
    expect(within(history).getByText('F · p75_query_count_last_30d = 18898')).toHaveAttribute('title', 'Fleet-wide baselines');
    expect(within(history).getByText('Look at what queries are running')).toBeInTheDocument();
    expect(within(history).getByText('Suggestions only. Nothing is done automatically.')).toBeInTheDocument();
    expect(fetchImpl.callsTo('GET', '/api/alerts/1/triage')).toHaveLength(1);
  });

  it('the button reflects whether the explanation is open, and closing it hides it', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view() }) });
    const history = await openExplain();
    const toggle = within(history).getByRole('button', { name: /Hide alert 1/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await userEvent.click(toggle);
    expect(within(history).queryByText('Checked against the data')).toBeNull();
    expect(within(history).getByRole('button', { name: /Explain alert 1/ })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a suggestion held for review is NOT shown to a viewer: only a message', async () => {
    const held = { id: 'T-1', event_id: 1, report_id: 'RPT_201', status: 'UNDER_REVIEW', triager: 'anthropic', model: 'claude-opus-5-5', created_at: 'x', message: 'A suggestion was produced but could not be fully verified against the data, so a person is checking it first.' };
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: held }) });
    const history = await openExplain();
    expect(await within(history).findByText('Under review')).toBeInTheDocument();
    expect(within(history).getByText(/a person is checking it first/)).toBeInTheDocument();
    expect(within(history).queryByText('Possible causes')).toBeNull();
    expect(within(history).queryByText(/·.*=/)).toBeNull(); // no evidence chips
    expect(within(history).queryByText(/Why it was held/)).toBeNull();
  });

  it('a withheld suggestion says it did not match the data and shows nothing else', async () => {
    const withheld = { id: 'T-1', event_id: 1, report_id: 'RPT_201', status: 'WITHHELD', triager: 'anthropic', model: 'claude-opus-5-5', created_at: 'x', message: 'A suggestion was produced but it did not match the data, so it was withheld.' };
    renderApp({ role: 'owner', path: '/alerts', routes: alertsRoutes({ data: withheld }) });
    const history = await openExplain();
    expect(await within(history).findByText('Withheld')).toBeInTheDocument();
    expect(within(history).getByText(/did not match the data/)).toBeInTheDocument();
    expect(within(history).queryByText('Possible causes')).toBeNull();
  });

  it('says who wrote it: an AI (with its model), rules, or rules because the AI was unavailable', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view({ triager: 'anthropic', model: 'claude-opus-5-5' }) }) });
    let history = await openExplain();
    expect(await within(history).findByText('Written by an AI (claude-opus-5-5) and checked against the data.')).toBeInTheDocument();
  });

  it('the author line never claims a check that failed: held and withheld AI answers say so', async () => {
    const make = (status) => ({ id: 'T-1', event_id: 1, report_id: 'RPT_201', status, triager: 'anthropic', model: 'm', created_at: 'x', message: 'x' });
    for (const [status, text] of [['UNDER_REVIEW', 'Written by an AI (m). It could not be fully verified against the data.'], ['WITHHELD', 'Written by an AI (m). It contradicted the data.'], ['DISMISSED', 'Written by an AI (m). A person chose not to show it.']]) {
      const r = renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: make(status) }) });
      const history = await openExplain();
      expect(await within(history).findByText(text)).toBeInTheDocument();
      expect(within(history).queryByText(/and checked against the data/)).toBeNull();
      r.unmount();
    }
  });

  it('shows when rules answered because the AI could not', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view({ fallback: { from: 'anthropic' } }) }) });
    const history = await openExplain();
    expect(await within(history).findByText(/the AI was unavailable, so rules were used/)).toBeInTheDocument();
  });

  it('an approved suggestion is shown and says a person reviewed it', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view({ status: 'APPROVED', reviewed_by_a_person: true, triager: 'anthropic', model: 'm' }) }) });
    const history = await openExplain();
    expect(await within(history).findByText('Approved by a person')).toBeInTheDocument();
    expect(within(history).getByText('A person reviewed this suggestion before it was shown.')).toBeInTheDocument();
    expect(within(history).getByText('High query volume')).toBeInTheDocument();
  });

  it('only admins see why a suggestion was held', async () => {
    const findings = [{ code: 'OTHER_UNVERIFIABLE', severity: 'review', message: 'This cause cannot be checked against the data.', where: 'causes[0]' }];
    renderApp({ role: 'admin', path: '/alerts', routes: { ...alertsRoutes({ data: view({ status: 'APPROVED', findings }) }), 'GET /api/costs/reports': { ...page([]), meta: { credit_price_usd: 3, price_is_placeholder: true } } } });
    const history = await openExplain();
    expect(await within(history).findByText('Why it was held (1)')).toBeInTheDocument();
    expect(within(history).getByText('OTHER_UNVERIFIABLE')).toBeInTheDocument();
    expect(within(history).getByText('Unverified')).toBeInTheDocument();
  });

  it('held reasons stay hidden from non-admins even if a response ever included them (defence in depth)', async () => {
    const findings = [{ code: 'OTHER_UNVERIFIABLE', severity: 'review', message: 'This cause cannot be checked against the data.' }];
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view({ status: 'APPROVED', findings }) }) });
    const history = await openExplain();
    expect(await within(history).findByText('Approved by a person')).toBeInTheDocument();
    expect(within(history).queryByText(/Why it was held/)).toBeNull();
    expect(within(history).queryByText('OTHER_UNVERIFIABLE')).toBeNull();
  });

  it('too many requests and other errors are explained in plain words, with a retry', async () => {
    let fail = true;
    renderApp({
      role: 'viewer', path: '/alerts',
      routes: alertsRoutes(() => (fail ? { status: 429, body: { error: { code: 'RATE_LIMITED', message: 'Too many explanations requested.' } } } : { status: 200, body: { data: view() } })),
    });
    const history = await openExplain();
    expect(await within(history).findByRole('alert')).toHaveTextContent('Too many explanations were requested. Wait a moment and try again.');
    fail = false;
    await userEvent.click(within(history).getByRole('button', { name: 'Try again' }));
    expect(await within(history).findByText('Checked against the data')).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------ admin review page

const okChecks = [
  { id: 'shape', label: 'It has the required shape', result: 'OK' },
  { id: 'cites', label: 'Every number it quotes matches the data', result: 'OK' },
];
const stand = { triager: 'baseline', model: null, status: 'TRUSTED', suggestion, checks: okChecks };
const withheldView = (extra = {}) => ({
  id: 'T-1', event_id: 1, report_id: 'RPT_201', status: 'WITHHELD', triager: 'ollama', model: 'llama3.1:8b', created_at: 'x', evidence, alternative: stand,
  message: 'The AI produced an explanation but it did not match the data, so it was withheld. The rule-based explanation, which was checked against the data, is shown instead.', ...extra,
});
const adminHeld = (extra = {}) => ({
  id: 'T-1', event_id: 1, report_id: 'RPT_201', status: 'UNDER_REVIEW', validation: 'NEEDS_REVIEW', triager: 'ollama', model: 'llama3.1:8b', created_at: 'x',
  suggestion, evidence, alternative: stand, review: { state: 'pending', by: null, at: null, note: null },
  checks: [{ id: 'shape', label: 'It has the required shape', result: 'OK' }, { id: 'causes', label: 'Each cause is supported by the data', result: 'UNVERIFIED' }],
  findings: [{ code: 'OTHER_UNVERIFIABLE', severity: 'review', message: 'This cause cannot be checked against the data.', where: 'causes[0]' }], ...extra,
});

describe('Explain this alert: the checked answer stands in, and decisions happen on the alert', () => {
  afterEach(() => vi.useRealTimers());

  it('a viewer whose AI answer was withheld gets the rule-based one, labelled as such, with how it was checked, and no buttons', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: withheldView() }) });
    const history = await openExplain();
    const section = await within(history).findByRole('region', { name: 'Rule-based explanation' });
    expect(within(section).getByText('Rule-based explanation, checked against the data')).toBeInTheDocument();
    expect(within(section).getByText('High query volume')).toBeInTheDocument();
    expect(within(section).getByText('How it was checked: all 2 checks passed')).toBeInTheDocument();
    expect(within(history).getByText(/is shown instead/)).toBeInTheDocument();
    expect(within(history).queryByRole('button', { name: /Approve|Dismiss/ })).toBeNull();
    expect(within(history).queryByText("See the AI's suggestion and its evidence")).toBeNull();
    expect(within(section).getAllByText('O1 · query_count_last_30d = 21000')[0]).toHaveAttribute('title', 'The reading that raised the alert'); // the evidence its claims cite comes with it
  });

  it('buttons are for admins only, even if a response ever carried review data (defence in depth)', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: adminHeld() }) });
    const history = await openExplain();
    await within(history).findByRole('region', { name: 'Rule-based explanation' });
    expect(within(history).queryByRole('button', { name: /Approve|Dismiss/ })).toBeNull();
  });

  it('a shown suggestion lists how it was checked', async () => {
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes({ data: view({ checks: okChecks }) }) });
    const history = await openExplain();
    const summary = await within(history).findByText('How it was checked: all 2 checks passed');
    expect(summary.closest('details')).not.toHaveAttribute('open'); // nothing to look at when everything passed
    const list = within(history).getByRole('list', { name: 'How it was checked', hidden: true });
    expect(within(list).getAllByRole('listitem', { hidden: true })).toHaveLength(2);
  });

  it('a check that did not pass is open by default and says so in words, not colour alone', async () => {
    renderApp({ role: 'admin', path: '/alerts', routes: alertsRoutes({ data: adminHeld() }) });
    const history = await openExplain();
    const summary = await within(history).findByText('How it was checked: 1 of 2 did not pass');
    expect(within(history).getByText('(could not be checked against the data)')).toBeInTheDocument();
    expect(summary.closest('details')).toHaveAttribute('open');
    const [passed, unverified] = within(history).getAllByRole('listitem', { hidden: true }).filter((li) => li.dataset.result);
    expect(passed.dataset.result).toBe('OK');
    expect(unverified.dataset.result).toBe('UNVERIFIED');
    expect(passed.querySelector('path').getAttribute('d')).not.toBe(unverified.querySelector('path').getAttribute('d')); // a different symbol, not only a different colour
  });

  it('an admin decides on the alert itself: approve sends the note, then the panel reloads', async () => {
    let state = adminHeld();
    const { fetchImpl } = renderApp({
      role: 'admin', path: '/alerts',
      routes: { ...alertsRoutes(() => ({ status: 200, body: { data: state } })), 'POST /api/triage/1/review': () => { state = view({ status: 'APPROVED', triager: 'ollama', model: 'llama3.1:8b' }); return { status: 200, body: { data: state } }; } },
    });
    const history = await openExplain();
    expect(await within(history).findByText('Why it was held (1)')).toBeInTheDocument();
    await userEvent.type(within(history).getByLabelText('Note (optional)'), 'Looks right');
    await userEvent.click(within(history).getByRole('button', { name: 'Approve the suggestion for alert 1' }));
    await waitFor(() => expect(fetchImpl.callsTo('POST', '/api/triage/1/review')[0].body).toEqual({ decision: 'approve', note: 'Looks right' }));
    expect(await within(history).findByText('Approved by a person')).toBeInTheDocument();
    expect(within(history).queryByRole('button', { name: /Approve the suggestion/ })).toBeNull();
    expect(fetchImpl.callsTo('GET', '/api/alerts/1/triage')).toHaveLength(2);
  });

  it('an admin can dismiss from the alert, and a contradicted suggestion cannot be approved there', async () => {
    const rejected = adminHeld({ status: 'WITHHELD', validation: 'REJECTED' });
    const { fetchImpl } = renderApp({ role: 'admin', path: '/alerts', routes: { ...alertsRoutes({ data: rejected }), 'POST /api/triage/1/review': { data: rejected } } });
    const history = await openExplain();
    expect(await within(history).findByRole('button', { name: 'Approve the suggestion for alert 1' })).toBeDisabled();
    await userEvent.click(within(history).getByRole('button', { name: 'Dismiss the suggestion for alert 1' }));
    await waitFor(() => expect(fetchImpl.callsTo('POST', '/api/triage/1/review')[0].body).toEqual({ decision: 'dismiss' }));
  });

  it('an admin sees both the AI answer and the rule-based one that everyone else gets', async () => {
    renderApp({ role: 'admin', path: '/alerts', routes: alertsRoutes({ data: adminHeld() }) });
    const history = await openExplain();
    expect(await within(history).findByText("See the AI's suggestion and its evidence")).toBeInTheDocument();
    expect(within(history).getByText('What everyone else sees instead: the rule-based explanation')).toBeInTheDocument();
  });

  it('once decided there are no buttons', async () => {
    renderApp({ role: 'admin', path: '/alerts', routes: alertsRoutes({ data: adminHeld({ status: 'DISMISSED', review: { state: 'dismissed', by: 'a', at: 'x', note: null } }) }) });
    const history = await openExplain();
    await within(history).findByText('Dismissed');
    expect(within(history).queryByRole('button', { name: /Approve the suggestion/ })).toBeNull();
  });

  it('while it is working, the wait is counted in seconds and a hint appears after a few', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderApp({ role: 'viewer', path: '/alerts', routes: alertsRoutes(() => new Promise(() => {})) });
    const history = await screen.findByRole('list', { name: 'Alert history' });
    await userEvent.setup({ advanceTimers: vi.advanceTimersByTime }).click(within(history).getByRole('button', { name: /Explain alert 1/ }));
    const status = await within(history).findByRole('status');
    expect(status).toHaveTextContent(/Writing the explanation and checking it against the data… \d s/);
    expect(status).not.toHaveTextContent('10 to 30 seconds');
    await vi.advanceTimersByTimeAsync(6000);
    expect(status).toHaveTextContent('An AI model can take 10 to 30 seconds.');
  });
});

const held = (id, extra = {}) => ({
  id: `T-${id}`, event_id: id, report_id: 'RPT_201', status: 'UNDER_REVIEW', validation: 'NEEDS_REVIEW', triager: 'anthropic', model: 'claude-opus-5-5', created_at: 'x',
  suggestion, evidence, usage: null, baseline_validation: 'TRUSTED', review: { state: 'pending', by: null, at: null, note: null },
  findings: [{ code: 'OTHER_UNVERIFIABLE', severity: 'review', message: 'This cause cannot be checked against the data.', where: 'causes[0]' }], ...extra,
});
const stats = {
  explained: 12, validation: { TRUSTED: 8, NEEDS_REVIEW: 3, REJECTED: 1 },
  by_triager: { baseline: { total: 6, TRUSTED: 5, NEEDS_REVIEW: 1, REJECTED: 0 }, anthropic: { total: 6, TRUSTED: 3, NEEDS_REVIEW: 2, REJECTED: 1 } },
  finding_codes: { OTHER_UNVERIFIABLE: 3, VALUE_MISMATCH: 1 }, review: { pending: 4 },
  ai_vs_rules: { compared: 6, ai_trusted: 3, rules_trusted: 5, ai_rejected: 1 }, model_calls: 6, fallbacks: 2, tokens: { input: 5400, output: 1800 },
  provider: { name: 'anthropic', model: 'claude-opus-5-5' },
};
const reviewRoutes = (queue, extra = {}) => ({ ...baseRoutes, 'GET /api/triage/stats': { data: stats }, 'GET /api/triage/review': typeof queue === 'function' ? queue : { data: queue }, ...extra });

describe('AI review page', () => {
  it('shows the verdicts, who wrote them, the AI against the rule-based control, and why things were held', async () => {
    renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([]) });
    expect(await screen.findByText('Passed the checks')).toBeInTheDocument();
    expect(screen.getByText('AI on: claude-opus-5-5')).toBeInTheDocument();
    const who = screen.getByRole('table', { name: 'Verdicts by who wrote the explanation' });
    expect(within(who).getByText('Rules (no AI)')).toBeInTheDocument();
    expect(within(who).getByText('AI (claude-opus-5-5)')).toBeInTheDocument();
    const bars = screen.getByRole('list', { name: 'Verdicts by writer' }); // the same figures, drawn
    expect(within(bars).getByText('Rules (no AI)')).toBeInTheDocument();
    expect(within(bars).getByText('AI (claude-opus-5-5)')).toBeInTheDocument();
    expect(screen.getByText(/On the same 6 alerts, the AI passed the checks 3 times and the rules 5 times/)).toBeInTheDocument();
    expect(screen.getByText(/The AI was unavailable 2 times, so rules answered instead/)).toBeInTheDocument();
    expect(screen.getByText('A cause the data cannot confirm')).toBeInTheDocument();
    expect(screen.getByText('Nothing is waiting.')).toBeInTheDocument();
  });

  it('puts what needs a decision first and the statistics after', async () => {
    renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([held(7)]) });
    const decide = await screen.findByRole('heading', { name: 'Needs your decision (1)' });
    const doing = screen.getByRole('heading', { name: 'How the AI is doing' });
    expect(decide.compareDocumentPosition(doing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/Until you decide, others see nothing for this alert/)).toBeInTheDocument();
  });

  it('says which explanation others see meanwhile when the rule-based one stands in', async () => {
    renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([held(7, { alternative: { triager: 'baseline', suggestion, checks: [] } })]) });
    expect(await screen.findByText(/others see the rule-based explanation/)).toBeInTheDocument();
  });

  it('with nothing waiting it links to the alerts, where explanations are made', async () => {
    renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([]) });
    expect(await screen.findByRole('link', { name: 'go to Alerts' })).toHaveAttribute('href', '/alerts');
  });

  it('approving sends the decision and the note, then refreshes the queue', async () => {
    let queue = [held(7)];
    const { fetchImpl } = renderApp({
      role: 'admin', path: '/ai-review',
      routes: reviewRoutes(() => ({ status: 200, body: { data: queue } }), { 'POST /api/triage/7/review': () => { queue = []; return { status: 200, body: { data: held(7, { status: 'APPROVED' }) } }; } }),
    });
    expect(await screen.findByRole('heading', { name: /RPT_201/ })).toBeInTheDocument();
    expect(screen.getByText('Could not be verified')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Note (optional)'), 'Checked with the owner');
    await userEvent.click(screen.getByRole('button', { name: 'Approve the suggestion for alert 7' }));
    await waitFor(() => expect(fetchImpl.callsTo('POST', '/api/triage/7/review')).toHaveLength(1));
    expect(fetchImpl.callsTo('POST', '/api/triage/7/review')[0].body).toEqual({ decision: 'approve', note: 'Checked with the owner' });
    expect(await screen.findByText('Nothing is waiting.')).toBeInTheDocument();
  });

  it('a suggestion that contradicts the data cannot be approved, only dismissed', async () => {
    const rejected = held(8, { validation: 'REJECTED', status: 'WITHHELD', findings: [{ code: 'VALUE_MISMATCH', severity: 'error', message: 'Says O1.query_count_last_30d is "25000" but the data says "21000".', where: 'causes[0].cites[0]' }] });
    const { fetchImpl } = renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([rejected], { 'POST /api/triage/8/review': { data: held(8, { status: 'DISMISSED' }) } }) });
    expect(await screen.findByText('Contradicts the data')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve the suggestion for alert 8' })).toBeDisabled();
    expect(screen.getByText(/cannot be approved/)).toBeInTheDocument();
    expect(screen.getByText('False')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss the suggestion for alert 8' }));
    await waitFor(() => expect(fetchImpl.callsTo('POST', '/api/triage/8/review')[0].body).toEqual({ decision: 'dismiss' }));
  });

  it('a rejected decision shows the server\'s reason', async () => {
    renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([held(9)], { 'POST /api/triage/9/review': { status: 409, body: { error: { code: 'ALREADY_REVIEWED', message: 'That suggestion has already been reviewed.' } } } }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Approve the suggestion for alert 9' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That suggestion has already been reviewed.');
  });

  it('the suggestion and its evidence can be inspected before deciding', async () => {
    renderApp({ role: 'admin', path: '/ai-review', routes: reviewRoutes([held(10)]) });
    await userEvent.click(await screen.findByText('See the suggestion and its evidence'));
    expect(screen.getAllByText('O1 · query_count_last_30d = 21000').length).toBeGreaterThan(0);
  });

  it.each(['viewer', 'owner'])('%s cannot open it: "No access", and nothing is fetched', async (role) => {
    const { fetchImpl } = renderApp({ role, path: '/ai-review', routes: baseRoutes });
    expect(await screen.findByRole('heading', { name: 'No access' })).toBeInTheDocument();
    expect(fetchImpl.calls.filter((c) => c.path.startsWith('/api/triage'))).toEqual([]);
  });

  it('the menu offers it to admins only', async () => {
    const nav = () => within(screen.getByRole('navigation', { name: 'Main' }));
    const admin = renderApp({ role: 'admin', routes: { ...baseRoutes, 'GET /api/costs/reports': { ...page([]), meta: { credit_price_usd: 3, price_is_placeholder: true } } } });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(nav().getByRole('link', { name: 'AI review' })).toBeInTheDocument();
    admin.unmount();
    renderApp({ role: 'viewer', routes: baseRoutes });
    await screen.findByRole('heading', { name: 'Overview' });
    expect(nav().queryByRole('link', { name: 'AI review' })).toBeNull();
  });
});
