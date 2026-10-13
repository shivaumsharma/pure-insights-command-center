// Framework-free WebSocket client for the alert feed. Everything that touches the network or the clock is injected,
// so reconnect, backoff, resume and gap handling can be tested exactly. Protocol: docs/api-spec.md.
//
//   open -> send {type:"auth", token, last_event_id?}  ->  "ready"  ->  missed alerts  ->  live alerts
//
// Reconnects use exponential backoff with jitter and resume from the last event id seen, so nothing is missed or doubled.

export const FEED_STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  UNAUTHORIZED: 'unauthorized', // token rejected or expired: sign in again
  BLOCKED: 'blocked', // too many open connections for this user
  ERROR: 'error', // the server rejected our messages; retrying would not help
  STOPPED: 'stopped',
};

const CLOSE = { UNAUTHENTICATED: 4401, TOO_MANY: 4429, UNSUPPORTED: 1003, POLICY: 1008, TOO_BIG: 1009 };

export function createLiveFeed({
  url,
  getToken,
  onStatus = () => {},
  onAlert = () => {},
  onGap = () => {},
  onAuthFailed = () => {},
  WebSocketImpl = globalThis.WebSocket,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (id) => clearTimeout(id),
  random = Math.random,
  baseDelayMs = 1000,
  maxDelayMs = 30_000,
}) {
  let ws = null;
  let timer = null;
  let attempt = 0;
  let lastEventId = null;
  let streamId = null; // names one run of the server; event ids only mean something within the same run
  let stopped = true;
  let status = FEED_STATUS.IDLE;

  const setStatus = (next) => {
    if (next === status) return;
    status = next;
    onStatus(next);
  };

  // "Equal jitter": half fixed, half random, so many clients do not reconnect in lockstep after a server restart.
  const delayFor = (n) => {
    const raw = Math.min(maxDelayMs, baseDelayMs * 2 ** n);
    return Math.round(raw / 2 + random() * (raw / 2));
  };

  function connect() {
    timer = null;
    if (stopped) return;
    setStatus(attempt === 0 && lastEventId === null ? FEED_STATUS.CONNECTING : FEED_STATUS.RECONNECTING);

    const socket = new WebSocketImpl(url);
    ws = socket;
    socket.onopen = () => {
      const token = getToken();
      if (!token) {
        socket.close(1000);
        setStatus(FEED_STATUS.UNAUTHORIZED);
        stopped = true;
        onAuthFailed();
        return;
      }
      const hello = { type: 'auth', token };
      if (lastEventId !== null) hello.last_event_id = lastEventId;
      if (streamId !== null) hello.stream_id = streamId;
      socket.send(JSON.stringify(hello));
    };
    socket.onmessage = (event) => handleMessage(event.data);
    socket.onerror = () => {}; // a close event always follows and carries the information we need
    socket.onclose = (event) => {
      if (ws === socket) ws = null;
      handleClose(event.code);
    };
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.type === 'ready') {
      attempt = 0;
      const restarted = streamId !== null && typeof msg.stream_id === 'string' && msg.stream_id !== streamId;
      if (restarted) {
        // The server restarted: our old position belongs to a different run and its ids start again from 1.
        // Without this, every new alert would look like a duplicate and be silently dropped.
        lastEventId = Number.isInteger(msg.last_event_id) ? msg.last_event_id : null;
      } else if (lastEventId === null && Number.isInteger(msg.last_event_id)) {
        // First connection: remember where the stream was, so a drop right after this can resume from here.
        lastEventId = msg.last_event_id;
      }
      if (typeof msg.stream_id === 'string') streamId = msg.stream_id;
      setStatus(FEED_STATUS.LIVE);
    } else if (msg.type === 'alert') {
      if (lastEventId !== null && msg.event_id <= lastEventId) return; // already delivered
      lastEventId = msg.event_id;
      onAlert(msg);
    } else if (msg.type === 'gap') {
      // An older server without stream ids can still tell us we are ahead of it.
      if (lastEventId !== null && Number.isInteger(msg.last_event_id) && msg.last_event_id < lastEventId) lastEventId = msg.last_event_id;
      onGap(msg);
    }
  }

  function handleClose(code) {
    if (stopped) {
      // A terminal status we set ourselves (unauthorized, blocked, error) must not be overwritten by the close event that follows.
      if (![FEED_STATUS.UNAUTHORIZED, FEED_STATUS.BLOCKED, FEED_STATUS.ERROR].includes(status)) setStatus(FEED_STATUS.STOPPED);
      return;
    }
    if (code === CLOSE.UNAUTHENTICATED) {
      stopped = true;
      setStatus(FEED_STATUS.UNAUTHORIZED);
      return onAuthFailed();
    }
    if (code === CLOSE.TOO_MANY) {
      stopped = true;
      return setStatus(FEED_STATUS.BLOCKED);
    }
    if ([CLOSE.UNSUPPORTED, CLOSE.POLICY, CLOSE.TOO_BIG].includes(code)) {
      stopped = true;
      return setStatus(FEED_STATUS.ERROR);
    }
    setStatus(FEED_STATUS.RECONNECTING);
    timer = schedule(connect, delayFor(attempt));
    attempt++;
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempt = 0;
      connect();
    },
    stop() {
      stopped = true;
      if (timer !== null) cancel(timer);
      timer = null;
      const socket = ws;
      ws = null;
      socket?.close(1000);
      setStatus(FEED_STATUS.STOPPED);
    },
    // The browser regained its network connection: do not wait out the backoff.
    notifyOnline() {
      if (stopped || timer === null) return;
      cancel(timer);
      attempt = 0;
      connect();
    },
    lastEventId: () => lastEventId,
    status: () => status,
  };
}
