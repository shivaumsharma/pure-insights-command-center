import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../auth/AuthContext.jsx';
import { createLiveFeed, FEED_STATUS } from '../lib/liveFeed.js';

const LiveContext = createContext({ status: FEED_STATUS.IDLE, events: [], gaps: 0, version: 0 });
const MAX_EVENTS = 100;
const REFETCH_EVERY_MS = 2000;

export function wsUrl(loc = window.location) {
  return `${loc.protocol === 'https:' ? 'wss:' : 'ws:'}//${loc.host}/ws`;
}

// Owns the single WebSocket for the signed-in session. `version` ticks (at most every 2 s) when alerts arrive, so pages
// that show server-side lists (active alerts, counts) can refetch without hammering the API during a burst.
export function LiveProvider({ children, WebSocketImpl }) {
  const { token, logout } = useAuth();
  const [status, setStatus] = useState(FEED_STATUS.IDLE);
  const [events, setEvents] = useState([]);
  const [gaps, setGaps] = useState(0);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!token) return undefined;
    let pending = null;
    let missedWhileHidden = false;
    const bump = () => {
      if (document.hidden) { missedWhileHidden = true; return; } // nobody is looking: do not hammer the API
      if (pending !== null) return;
      pending = setTimeout(() => { pending = null; setVersion((v) => v + 1); }, REFETCH_EVERY_MS);
    };
    const onVisible = () => { if (!document.hidden && missedWhileHidden) { missedWhileHidden = false; bump(); } };
    const feed = createLiveFeed({
      url: wsUrl(),
      getToken: () => token,
      WebSocketImpl,
      onStatus: setStatus,
      onAlert: (alert) => { setEvents((prev) => [alert, ...prev].slice(0, MAX_EVENTS)); bump(); },
      onGap: () => { setGaps((g) => g + 1); bump(); },
      onAuthFailed: () => logout('Your session has expired. Please sign in again.'),
    });
    feed.start();
    const online = () => feed.notifyOnline();
    window.addEventListener('online', online);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', online);
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(pending);
      feed.stop();
      setEvents([]);
      setGaps(0);
    };
  }, [token, logout, WebSocketImpl]);

  const value = useMemo(() => ({ status, events, gaps, version }), [status, events, gaps, version]);
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export const useLive = () => useContext(LiveContext);
