import { useEffect, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { useQuery } from '../lib/useQuery.js';
import { ReviewActions } from './ReviewActions.jsx';
import { Badge, ErrorBox } from './ui.jsx';
import { CheckSummary, Findings, STATUS_LABEL_TRIAGE, SuggestionView, authorLine } from './SuggestionView.jsx';

// Shown while the explanation is being written and checked. An AI model can take half a minute, so say it is working and for how long.
export function Working() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="working" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>Writing the explanation and checking it against the data… {seconds} s</span>
      {seconds >= 5 && <span className="muted small"> An AI model can take 10 to 30 seconds.</span>}
    </div>
  );
}

// "Explain this alert". Loaded only when opened. The server decides what this person may see. A suggestion that could not be verified is not shown
// to most people; if the rule-based answer for the same alert passed the checks, that is shown instead, so there is always something useful when the data
// supports one. An admin sees everything here, including why it was held, and can approve or dismiss it without leaving the alert.
export function TriagePanel({ eventId, id }) {
  const { api, user } = useAuth();
  const result = useQuery(() => api.get(`/api/alerts/${eventId}/triage`), [api, eventId]);

  if (result.error) {
    const message = result.error.status === 429 ? 'Too many explanations were requested. Wait a moment and try again.' : result.error.message;
    return <div className="triage" id={id}><ErrorBox error={{ message }} onRetry={result.reload} /></div>;
  }
  if (!result.data) return <div className="triage" id={id}><Working /></div>;

  const data = result.data.data;
  const [tone, label] = STATUS_LABEL_TRIAGE[data.status] ?? ['neutral', data.status];
  const admin = user.role === 'admin';
  const shown = data.status === 'TRUSTED' || data.status === 'APPROVED';

  return (
    <div className="triage" id={id} aria-live="polite">
      <p>
        <Badge tone={tone}>{label}</Badge> <span className="muted small">{authorLine(data)}</span>
      </p>
      {data.message && <p className="small">{data.message}</p>}
      {data.reviewed_by_a_person && <p className="muted small">A person reviewed this suggestion before it was shown.</p>}

      {admin && data.findings?.length > 0 && (
        <>
          <h4>Why it was held ({data.findings.length})</h4>
          <Findings findings={data.findings} />
        </>
      )}

      {data.suggestion && (shown ? <SuggestionView data={data} /> : (
        <details>
          <summary>See the AI&apos;s suggestion and its evidence</summary>
          <SuggestionView data={data} />
        </details>
      ))}
      {data.suggestion && <CheckSummary checks={data.checks} />}

      {admin && data.review?.state === 'pending' && <ReviewActions item={data} onDone={result.reload} />}

      {data.alternative && (
        <section className="alternative" aria-label="Rule-based explanation">
          <h4>{admin ? 'What everyone else sees instead: the rule-based explanation' : 'Rule-based explanation, checked against the data'}</h4>
          <p className="muted small">No AI was used for this one. It applies fixed tests to the same evidence.</p>
          <SuggestionView data={{ ...data.alternative, evidence: data.evidence }} />
          <CheckSummary checks={data.alternative.checks} />
        </section>
      )}
    </div>
  );
}
