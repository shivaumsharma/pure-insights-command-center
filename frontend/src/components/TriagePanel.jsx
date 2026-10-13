import { useAuth } from '../auth/AuthContext.jsx';
import { useQuery } from '../lib/useQuery.js';
import { Badge, ErrorBox, Skeleton } from './ui.jsx';
import { Findings, STATUS_LABEL_TRIAGE, SuggestionView, authorLine } from './SuggestionView.jsx';

// "Explain this alert". Loaded only when opened. The server decides what this person may see: a suggestion that could not be
// verified against the data is held back and the panel says so instead of showing it.
export function TriagePanel({ eventId, id }) {
  const { api, user } = useAuth();
  const result = useQuery(() => api.get(`/api/alerts/${eventId}/triage`), [api, eventId]);

  if (result.error) {
    const message = result.error.status === 429 ? 'Too many explanations were requested. Wait a moment and try again.' : result.error.message;
    return <div className="triage" id={id}><ErrorBox error={{ message }} onRetry={result.reload} /></div>;
  }
  if (!result.data) return <div className="triage" id={id}><Skeleton rows={2} /></div>;

  const data = result.data.data;
  const [tone, label] = STATUS_LABEL_TRIAGE[data.status] ?? ['neutral', data.status];
  const admin = user.role === 'admin';

  return (
    <div className="triage" id={id} aria-live="polite">
      <p>
        <Badge tone={tone}>{label}</Badge> <span className="muted small">{authorLine(data)}</span>
      </p>
      {data.message && <p className="small">{data.message}</p>}
      {data.reviewed_by_a_person && <p className="muted small">A person reviewed this suggestion before it was shown.</p>}
      <SuggestionView data={data} />
      {admin && data.findings?.length > 0 && (
        <details>
          <summary>Why it was held ({data.findings.length})</summary>
          <Findings findings={data.findings} />
        </details>
      )}
    </div>
  );
}
