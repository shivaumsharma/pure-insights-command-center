import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fmtEventTime, plural } from '../lib/format.js';
import { TriagePanel } from './TriagePanel.jsx';
import { alertKind, Badge, Button, LifecycleBadge, SeverityBadge } from './ui.jsx';

// One alert as it appears in the live feed and the history. Not colour-only: severity, stage and kind are all text.
// A resolved alert leads with "Resolved" (not its old severity colour), so the list never looks like it is still on fire.
// Open alerts can be explained on request; resolved ones have nothing to explain.
export function AlertRow({ alert }) {
  const resolved = alert.lifecycle === 'RESOLVED';
  const [open, setOpen] = useState(false);
  const panelId = `triage-${alert.event_id}`;
  return (
    <li data-sev={resolved ? 'resolved' : alert.severity}>
      {resolved ? <Badge tone="success">Resolved</Badge> : <SeverityBadge severity={alert.severity} />}
      <div>
        <p>
          <Link to={`/reports/${alert.report_id}`}>{alert.report_id}</Link>{' '}
          <span className="muted">· {alertKind(alert)}</span>{' '}
          {!resolved && <LifecycleBadge lifecycle={alert.lifecycle} />}
        </p>
        <p className="small">{alert.message}</p>
      </div>
      <p className="feed-meta">
        {fmtEventTime(alert.observed_at)}
        {resolved && ` · was ${alert.severity}`}
        {alert.suppressed_since_last > 0 && ` · ${plural(alert.suppressed_since_last, 'repeat reading')} held back`}
        {!resolved && (
          <>
            {' · '}
            <Button
              variant="secondary" className="btn-small" aria-expanded={open} aria-controls={open ? panelId : undefined}
              aria-label={`${open ? 'Hide' : 'Explain'} alert ${alert.event_id} for ${alert.report_id}`}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? 'Hide explanation' : 'Explain'}
            </Button>
          </>
        )}
      </p>
      {open && <div className="triage-wrap"><TriagePanel eventId={alert.event_id} id={panelId} /></div>}
    </li>
  );
}
