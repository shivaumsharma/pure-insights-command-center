import { useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, Field } from './ui.jsx';

// An admin's decision on a held AI explanation: approve it (it is then shown to everyone) or dismiss it. One of these on the alert itself and one on
// the AI review page, so a person never has to leave what they are looking at to decide. A suggestion that contradicts the data cannot be approved.
export function ReviewActions({ item, onDone }) {
  const { api } = useAuth();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const contradicted = item.validation === 'REJECTED';

  async function decide(decision) {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/api/triage/${item.event_id}/review`, { decision, note: note.trim() || undefined });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="review-actions">
      {contradicted && <p className="hint">This suggestion is false against the data, so it cannot be approved. It can be dismissed.</p>}
      <div className="form-row">
        <Field id={`note-${item.event_id}`} label="Note (optional)">
          <input id={`note-${item.event_id}`} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button disabled={busy || contradicted} onClick={() => decide('approve')} aria-label={`Approve the suggestion for alert ${item.event_id}`}>Approve and show it</Button>
        <Button variant="secondary" disabled={busy} onClick={() => decide('dismiss')} aria-label={`Dismiss the suggestion for alert ${item.event_id}`}>Dismiss</Button>
      </div>
      {error && <p className="field-error" role="alert">{error}</p>}
    </div>
  );
}
