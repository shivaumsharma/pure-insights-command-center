// WebSocket hub: pushes alerts to signed-in users, filtered by role. Protocol is documented in docs/api-spec.md.
//
//   connect to /ws  ->  within wsAuthTimeoutMs send {"type":"auth","token":"<jwt>","last_event_id":<n, optional>}
//   server replies   {"type":"ready",...}, then (if last_event_id was sent) the alerts missed since, then live alerts.
//
// The token travels in the first message, never in the URL, so it cannot end up in access logs or browser history.

import { WebSocketServer } from 'ws';

const OPEN = 1;
const MAX_VIOLATIONS = 5;
const MAX_TIMER_MS = 2 ** 31 - 1;
const MAX_BUFFERED_BYTES = 1_000_000; // a client this far behind is dropped rather than letting memory grow

// The page that opened the socket was served by this same server (same scheme-less host and port), which is the normal
// production setup. Compared on the exact host so "localhost.evil.com" or a different port never matches.
function isSameOrigin(origin, host) {
  try {
    return Boolean(host) && new URL(origin).host === host;
  } catch {
    return false; // e.g. the literal "null" origin sent by sandboxed pages
  }
}

function rejectUpgrade(socket, status, text) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createHub({ server, tokens, alerts, config, logger = console, now = () => Date.now() }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: config.wsMaxPayload });
  const clients = new Set();
  const perUser = new Map();

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname !== '/ws') return rejectUpgrade(socket, 404, 'Not Found');
    // Browsers always send Origin; a page on another site must not be able to open this socket.
    // Allowed: the page was served by this server, or its origin is listed in ALLOWED_ORIGINS (e.g. the Vite dev server).
    const origin = req.headers.origin;
    if (origin && !isSameOrigin(origin, req.headers.host) && !config.allowedOrigins.includes(origin)) return rejectUpgrade(socket, 403, 'Forbidden');
    if (clients.size >= config.wsMaxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function send(client, message) {
    const { ws } = client;
    if (ws.readyState !== OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return ws.terminate();
    ws.send(JSON.stringify(message));
  }

  function fail(client, code, closeCode, message) {
    send(client, { type: 'error', code, message });
    client.ws.close(closeCode, code);
  }

  function onConnection(ws) {
    const client = { ws, user: null, isAlive: true, violations: 0, unsubscribe: null, timers: [] };
    clients.add(client);
    client.timers.push(setTimeout(() => fail(client, 'AUTH_TIMEOUT', 4401, 'Send an auth message first'), config.wsAuthTimeoutMs));

    ws.on('pong', () => { client.isAlive = true; });
    ws.on('error', (err) => logger.error?.('WebSocket error:', err.message));
    ws.on('close', () => cleanup(client));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return fail(client, 'BAD_REQUEST', 1003, 'Text frames only');
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return violation(client, 'Messages must be JSON');
      }
      if (msg === null || typeof msg !== 'object' || typeof msg.type !== 'string') return violation(client, 'Message needs a "type"');

      if (!client.user) {
        if (msg.type !== 'auth') return fail(client, 'UNAUTHENTICATED', 4401, 'Authenticate first');
        return authenticate(client, msg);
      }
      if (msg.type === 'ping') return send(client, { type: 'pong', server_time: new Date(now()).toISOString() });
      return violation(client, `Unknown message type '${msg.type.slice(0, 40)}'`);
    });
  }

  function violation(client, message) {
    send(client, { type: 'error', code: 'BAD_REQUEST', message });
    if (++client.violations > MAX_VIOLATIONS) client.ws.close(1008, 'too many bad messages');
  }

  function authenticate(client, msg) {
    let claims;
    try {
      if (typeof msg.token !== 'string') throw new Error('no token');
      claims = tokens.verify(msg.token);
    } catch {
      return fail(client, 'UNAUTHENTICATED', 4401, 'Invalid or expired token');
    }

    let lastEventId;
    if (msg.last_event_id !== undefined) {
      if (!Number.isInteger(msg.last_event_id) || msg.last_event_id < 0) return fail(client, 'BAD_REQUEST', 1008, 'last_event_id must be a whole number');
      lastEventId = msg.last_event_id;
    }

    let streamId;
    if (msg.stream_id !== undefined) {
      if (typeof msg.stream_id !== 'string' || !/^[a-z0-9]{1,32}$/.test(msg.stream_id)) return fail(client, 'BAD_REQUEST', 1008, 'stream_id is not valid');
      streamId = msg.stream_id;
    }

    const user = { email: claims.email, role: claims.role };
    if ((perUser.get(user.email) ?? 0) >= config.wsMaxPerUser) return fail(client, 'TOO_MANY_CONNECTIONS', 4429, 'Too many open connections for this user');

    client.user = user;
    perUser.set(user.email, (perUser.get(user.email) ?? 0) + 1);
    clearTimeout(client.timers.shift()); // the auth timer

    // Everything below is synchronous, so no alert can slip between the replay and the live subscription.
    send(client, { type: 'ready', user, last_event_id: alerts.lastEventId(), stream_id: alerts.streamId(), server_time: new Date(now()).toISOString(), resumed: lastEventId !== undefined });
    if (lastEventId !== undefined) {
      if (streamId !== undefined && streamId !== alerts.streamId()) {
        // The client's position belongs to an earlier run of the server; those ids mean nothing here, so replay nothing.
        send(client, { type: 'gap', reason: 'restarted', oldest_event_id: alerts.oldestEventId(), last_event_id: alerts.lastEventId(), message: 'The server restarted; refetch state with GET /api/alerts' });
      } else {
        const { alerts: missed, gap, ahead, oldest_event_id } = alerts.since(user, lastEventId);
        if (gap) send(client, { type: 'gap', reason: ahead ? 'restarted' : 'dropped', oldest_event_id, last_event_id: alerts.lastEventId(), message: 'Some events were dropped; refetch state with GET /api/alerts' });
        for (const alert of missed) send(client, { type: 'alert', ...alert });
      }
    }
    client.unsubscribe = alerts.subscribe((event) => {
      if (alerts.visibleTo(user, event)) send(client, { type: 'alert', ...event });
    });

    // Close when the token expires, so a revoked-by-time session cannot stay connected forever.
    const msLeft = claims.exp * 1000 - now();
    client.timers.push(setTimeout(() => fail(client, 'TOKEN_EXPIRED', 4401, 'Token expired; sign in again'), Math.min(Math.max(msLeft, 0), MAX_TIMER_MS)));
  }

  function cleanup(client) {
    client.timers.forEach(clearTimeout);
    client.unsubscribe?.();
    if (client.user) {
      const left = (perUser.get(client.user.email) ?? 1) - 1;
      if (left <= 0) perUser.delete(client.user.email);
      else perUser.set(client.user.email, left);
    }
    clients.delete(client);
  }

  // Drop connections that stop answering pings (half-open TCP, sleeping laptops).
  const heartbeat = setInterval(() => {
    for (const client of clients) {
      if (!client.isAlive) { client.ws.terminate(); continue; }
      client.isAlive = false;
      client.ws.ping();
    }
  }, config.wsHeartbeatMs);
  heartbeat.unref?.();

  return {
    connectionCount: () => clients.size,
    close() {
      clearInterval(heartbeat);
      for (const client of clients) client.ws.close(1001, 'server shutting down');
      wss.close();
    },
  };
}
