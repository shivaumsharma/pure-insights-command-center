import { useLive } from '../live/LiveContext.jsx';

const LABEL = {
  idle: 'Offline',
  connecting: 'Connecting…',
  live: 'Live',
  reconnecting: 'Reconnecting…',
  unauthorized: 'Signed out',
  blocked: 'Too many open tabs',
  error: 'Feed error',
  stopped: 'Offline',
};

export function LiveStatus() {
  const { status } = useLive();
  return (
    <span className="live-pill" data-state={status} role="status">
      <span className="live-dot" aria-hidden="true" />
      <span><span className="live-label">Alerts: </span>{LABEL[status] ?? status}</span>
    </span>
  );
}
