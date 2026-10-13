import { Icon } from './Icon.jsx';
import { Badge } from './ui.jsx';

export const CAUSE_LABEL = {
  HIGH_QUERY_VOLUME: 'High query volume',
  HIGH_CONCURRENCY: 'Many users at once',
  RECURRING_SLOWNESS: 'Slow again and again',
  REPEATED_FAILURES: 'Refreshes failing repeatedly',
  OWNERSHIP_GAP: 'Nobody owns it',
  OTHER: 'Other (the data cannot confirm it)',
};
export const ACTION_LABEL = {
  INVESTIGATE_QUERIES: 'Look at what queries are running',
  REVIEW_CAPACITY: 'Check whether capacity is enough',
  CHECK_REFRESH_SCHEDULE: 'Check the refresh schedule and source',
  ASSIGN_OWNER: 'Assign an owner',
  MONITOR: 'Keep watching',
  NONE: 'No action suggested',
};
export const STATUS_LABEL_TRIAGE = {
  TRUSTED: ['success', 'Checked against the data'],
  APPROVED: ['info', 'Approved by a person'],
  UNDER_REVIEW: ['warning', 'Under review'],
  WITHHELD: ['danger', 'Withheld'],
  DISMISSED: ['neutral', 'Dismissed'],
};

// One citation, shown as the evidence it points at: "O1 · query_count_last_30d = 21000".
function Chip({ cite, evidence }) {
  const item = evidence?.items?.[cite.evidence];
  return (
    <code className="chip" title={item?.label}>
      {cite.evidence} · {cite.field} = {cite.value}
    </code>
  );
}

function Cites({ cites, evidence }) {
  if (!cites?.length) return null;
  return (
    <span className="chips">
      {cites.map((c, i) => <Chip key={`${c.evidence}.${c.field}.${i}`} cite={c} evidence={evidence} />)}
    </span>
  );
}

// Who wrote it matters: say so plainly, including when the AI was unavailable and rules were used instead.
const OUTCOME = {
  TRUSTED: ' and checked against the data.',
  APPROVED: ' and approved by a person.',
  UNDER_REVIEW: '. It could not be fully verified against the data.',
  WITHHELD: '. It contradicted the data.',
  DISMISSED: '. A person chose not to show it.',
};
export function authorLine(data) {
  if (data.triager === 'baseline') {
    return data.fallback ? 'Rule-based explanation (the AI was unavailable, so rules were used).' : 'Rule-based explanation. No AI was used.';
  }
  return `Written by an AI${data.model ? ` (${data.model})` : ''}${OUTCOME[data.status] ?? '.'}`;
}

// The suggestion itself, with the evidence behind every claim. Only rendered when the server decided it may be shown.
export function SuggestionView({ data }) {
  const s = data.suggestion;
  if (!s) return null;
  return (
    <div className="suggestion">
      <p>{s.summary}</p>

      {s.causes.length > 0 ? (
        <>
          <h4>Possible causes</h4>
          <ul className="plain-list">
            {s.causes.map((c, i) => (
              <li key={i}>
                <strong>{CAUSE_LABEL[c.kind] ?? c.kind}</strong> <span className="muted small">· {Math.round(c.confidence * 100)}% sure</span>
                <p className="small">{c.claim}</p>
                <Cites cites={c.cites} evidence={data.evidence} />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="muted small">The data does not show a clear cause.</p>
      )}

      {s.actions.length > 0 && (
        <>
          <h4>Suggested next steps</h4>
          <ul className="plain-list">
            {s.actions.map((a, i) => (
              <li key={i}>
                <strong>{ACTION_LABEL[a.kind] ?? a.kind}</strong>
                <p className="small">{a.rationale}</p>
                <Cites cites={a.cites} evidence={data.evidence} />
              </li>
            ))}
          </ul>
          <p className="hint">Suggestions only. Nothing is done automatically.</p>
        </>
      )}
    </div>
  );
}

// How the suggestion was checked, one line per question. The result is a symbol and words, never colour alone. Open by default only when
// something did not pass.
const CHECK_ICON = { OK: 'check', UNVERIFIED: 'help', FALSE: 'cross' };
const CHECK_NOTE = { UNVERIFIED: 'could not be checked against the data', FALSE: 'the data contradicts it' };
export function CheckSummary({ checks }) {
  if (!checks?.length) return null;
  const failed = checks.filter((c) => c.result !== 'OK').length;
  return (
    <details className="check-summary" open={failed > 0}>
      <summary>{failed === 0 ? `How it was checked: all ${checks.length} checks passed` : `How it was checked: ${failed} of ${checks.length} did not pass`}</summary>
      <ul className="checks" aria-label="How it was checked">
        {checks.map((c) => (
          <li key={c.id} data-result={c.result}>
            <Icon name={CHECK_ICON[c.result]} size={16} />
            <span>{c.label}{c.result !== 'OK' && <span className="muted"> ({CHECK_NOTE[c.result]})</span>}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function Findings({ findings }) {
  if (!findings?.length) return <p className="muted small">The checks found nothing to flag.</p>;
  return (
    <ul className="plain-list findings">
      {findings.map((f, i) => (
        <li key={i}>
          <Badge tone={f.severity === 'error' ? 'danger' : 'warning'}>{f.severity === 'error' ? 'False' : 'Unverified'}</Badge>{' '}
          <code className="small">{f.code}</code> <span className="small">{f.message}</span>
          {f.where && <span className="muted small"> ({f.where})</span>}
        </li>
      ))}
    </ul>
  );
}
