import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { StackBars } from '../components/charts/StackBars.jsx';
import { ReviewActions } from '../components/ReviewActions.jsx';
import { CheckSummary, Findings, SuggestionView, authorLine } from '../components/SuggestionView.jsx';
import { Badge, Card, DataTable, EmptyState, ErrorBox, Kpi, PageHeader, Skeleton } from '../components/ui.jsx';
import { fmtInt } from '../lib/format.js';
import { useQuery } from '../lib/useQuery.js';

const CODE_HELP = {
  VALUE_MISMATCH: 'Cited a value that is not what the data says',
  CAUSE_CONTRADICTED: 'Claimed a cause the data contradicts',
  UNKNOWN_EVIDENCE: 'Cited evidence that does not exist',
  UNKNOWN_FIELD: 'Cited a field that does not exist',
  SCHEMA_INVALID: 'Not in the required shape',
  SUSPICIOUS_TEXT: 'Contained a link, markup or an instruction',
  CONFIDENCE_OUT_OF_RANGE: 'Confidence outside 0 to 1',
  OTHER_UNVERIFIABLE: 'A cause the data cannot confirm',
  NO_CITATION: 'A claim with no evidence',
  NO_RELEVANT_CITATION: 'Cited evidence that does not show the claim',
  UNSUPPORTED_NUMBER: 'Used a number that is not in the evidence',
  ACTION_UNSUPPORTED: 'Suggested an action no supported cause justifies',
  OVERCONFIDENT: 'More sure than the data justifies',
  LOW_CONFIDENCE: 'Not confident',
  HUMAN_REQUESTED: 'Asked for a person to decide',
  NO_EXPLANATION: 'Gave no explanation',
  EVIDENCE_MISSING: 'The evidence needed to check it was missing',
  TOO_LONG: 'Longer than a short explanation',
};

function ReviewItem({ item, onDone }) {
  const contradicted = item.validation === 'REJECTED';
  return (
    <article className="card review-item" aria-labelledby={`rev-${item.event_id}`}>
      <h3 id={`rev-${item.event_id}`}>
        <Link to={`/reports/${item.report_id}`}>{item.report_id}</Link> <span className="muted small">alert {item.event_id}</span>{' '}
        <Badge tone={contradicted ? 'danger' : 'warning'}>{contradicted ? 'Contradicts the data' : 'Could not be verified'}</Badge>
      </h3>
      <p className="muted small">{authorLine(item)} Until you decide, others see {item.alternative ? 'the rule-based explanation' : 'nothing for this alert'}.</p>

      <h4>Why it was held</h4>
      <Findings findings={item.findings} />

      <details>
        <summary>See the suggestion and its evidence</summary>
        <SuggestionView data={item} />
      </details>
      <CheckSummary checks={item.checks} />

      <ReviewActions item={item} onDone={onDone} />
    </article>
  );
}

export default function AiReview() {
  const { api } = useAuth();
  useEffect(() => { document.title = 'AI review · Pure Insights'; }, []);
  const stats = useQuery(() => api.get('/api/triage/stats'), [api]);
  const queue = useQuery(() => api.get('/api/triage/review', { state: 'pending' }), [api]);

  const s = stats.data?.data;
  const trusted = s?.validation?.TRUSTED ?? 0;
  const held = s?.validation?.NEEDS_REVIEW ?? 0;
  const rejected = s?.validation?.REJECTED ?? 0;
  const refresh = () => { queue.reload(); stats.reload(); };
  const triagers = Object.entries(s?.by_triager ?? {});

  return (
    <>
      <PageHeader
        title="AI review"
        description="Every explanation is checked against the data before anyone sees it. Anything the checks could not confirm waits here for you to approve or dismiss."
      />

      <h2>Needs your decision{queue.data && queue.data.data.length > 0 ? ` (${queue.data.data.length})` : ''}</h2>
      <ErrorBox error={queue.error} onRetry={queue.reload} />
      {!queue.data && !queue.error && <Skeleton rows={3} />}
      {queue.data && queue.data.data.length === 0 && (
        <EmptyState icon="check" title="Nothing is waiting.">
          Explanations that pass the checks are shown straight away. To see one, open an alert and choose Explain: <Link to="/alerts">go to Alerts</Link>.
        </EmptyState>
      )}
      {queue.data && queue.data.data.map((item) => <ReviewItem key={item.event_id} item={item} onDone={refresh} />)}

      <h2>How the AI is doing</h2>
      <ErrorBox error={stats.error} onRetry={stats.reload} />
      {!s && !stats.error && <Skeleton rows={2} />}
      {s && (
        <>
          <div className="grid-kpi">
            <Kpi label="Explanations made" value={fmtInt(s.explained)} icon="sparkles" hint={s.provider ? `AI on: ${s.provider.model}` : 'Rule-based only (no AI configured)'} />
            <Kpi label="Passed the checks" value={fmtInt(trusted)} tone="success" icon="check" meter={s.explained > 0 ? (100 * trusted) / s.explained : 0} />
            <Kpi label="Held for a person" value={fmtInt(held)} tone={held > 0 ? 'warning' : undefined} icon="userOff" hint="Could not be fully verified" />
            <Kpi label="Contradicted the data" value={fmtInt(rejected)} tone={rejected > 0 ? 'danger' : undefined} icon="shield" hint="Withheld from everyone" />
          </div>

          {triagers.length > 0 && (
            <Card title="Who wrote them" subtitle="The rule-based writer is the control: the AI is judged by the same checks.">
              <StackBars
                label="Verdicts by writer"
                rows={triagers.map(([name, t]) => ({
                  key: name, label: name === 'baseline' ? 'Rules (no AI)' : `AI (${s.provider?.model ?? name})`, valueText: fmtInt(t.total),
                  segments: [{ value: t.TRUSTED, tone: 'success' }, { value: t.NEEDS_REVIEW, tone: 'warning' }, { value: t.REJECTED, tone: 'danger' }],
                }))}
                legend={[{ key: 'p', tone: 'success', label: 'Passed' }, { key: 'h', tone: 'warning', label: 'Held for a person' }, { key: 'r', tone: 'danger', label: 'Contradicted the data' }]}
              />
              <DataTable
                caption="Verdicts by who wrote the explanation"
                rows={triagers}
                rowKey={([name]) => name}
                columns={[
                  { key: 'n', header: 'Writer', render: ([name]) => (name === 'baseline' ? 'Rules (no AI)' : `AI (${s.provider?.model ?? name})`) },
                  { key: 't', header: 'Explanations', align: 'right', render: ([, t]) => fmtInt(t.total) },
                  { key: 'p', header: 'Passed', align: 'right', render: ([, t]) => fmtInt(t.TRUSTED) },
                  { key: 'h', header: 'Held', align: 'right', render: ([, t]) => fmtInt(t.NEEDS_REVIEW) },
                  { key: 'r', header: 'Contradicted', align: 'right', render: ([, t]) => fmtInt(t.REJECTED) },
                ]}
              />
              {s.ai_vs_rules.compared > 0 && (
                <p className="small" style={{ marginTop: 'var(--pi-space-3)' }}>
                  On the same {s.ai_vs_rules.compared} alerts, the AI passed the checks {s.ai_vs_rules.ai_trusted} times and the rules {s.ai_vs_rules.rules_trusted} times.
                  {s.fallbacks > 0 && ` The AI was unavailable ${s.fallbacks} times, so rules answered instead.`}
                </p>
              )}
            </Card>
          )}

          {Object.keys(s.finding_codes).length > 0 && (
            <Card title="Why explanations were held or withheld">
              <DataTable
                caption="Reasons explanations were flagged"
                rows={Object.entries(s.finding_codes).sort((a, b) => b[1] - a[1])}
                rowKey={([code]) => code}
                columns={[
                  { key: 'c', header: 'Reason', render: ([code]) => (<><strong>{CODE_HELP[code] ?? code}</strong> <code className="small muted">{code}</code></>) },
                  { key: 'n', header: 'Explanations', align: 'right', render: ([, n]) => fmtInt(n) },
                ]}
              />
            </Card>
          )}
        </>
      )}

    </>
  );
}
