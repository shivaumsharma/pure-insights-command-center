import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { Button, Field } from './ui.jsx';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Admin-only. Prefills the last known owner as a suggestion; the server re-validates everything.
export function AssignOwnerForm({ report, onAssigned, autoFocus = false }) {
  const { api } = useAuth();
  const [email, setEmail] = useState(report.last_known_owner_email ?? '');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);
  const input = useRef(null);

  useEffect(() => {
    setEmail(report.last_known_owner_email ?? '');
    setError(null);
    setDone(null);
    if (autoFocus) input.current?.focus();
  }, [report.report_id, report.last_known_owner_email, autoFocus]);

  async function submit(event) {
    event.preventDefault();
    const value = email.trim();
    if (!EMAIL.test(value)) {
      setError('Enter a valid email address, like name@company.com.');
      input.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.put(`/api/reports/${encodeURIComponent(report.report_id)}/owner`, { email: value });
      setDone(`${report.report_id} is now owned by ${res.data.owner_email}.`);
      onAssigned?.(res.data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <div className="form-row">
        <Field id={`owner-${report.report_id}`} label={`Owner for ${report.report_id}`} error={error}
          hint={report.last_known_owner_email ? 'Suggested: the last owner seen on this report.' : undefined}>
          <input ref={input} id={`owner-${report.report_id}`} type="email" autoComplete="off" value={email}
            aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `owner-${report.report_id}-error` : undefined}
            onChange={(e) => { setEmail(e.target.value); setError(null); setDone(null); }} />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? 'Assigning…' : 'Assign owner'}</Button>
      </div>
      {done && <p className="success-note" role="status">{done}</p>}
    </form>
  );
}
