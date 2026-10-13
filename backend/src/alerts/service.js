// Wraps the alert engine with: monotonically increasing event ids, a bounded history (for reconnects and the REST
// list), subscriptions (for the WebSocket hub) and the role filter that decides who may see which alert.

import crypto from 'node:crypto';
import { createAlertEngine } from './engine.js';

export function createAlertService({ store, cooldownMs, historyCapacity = 2000 }) {
  const engine = createAlertEngine({ cooldownMs });
  // Event ids restart at 1 whenever the server restarts. This random id names one run of the server, so a client holding an id
  // from an earlier run can tell its position is meaningless now instead of silently dropping the new alerts as "duplicates".
  const streamId = crypto.randomBytes(4).toString('hex');
  const history = []; // oldest first, each alert carries event_id
  const subscribers = new Set();
  let lastEventId = 0;

  // admin and viewer see the whole fleet; an owner sees alerts for reports they own at the moment of asking.
  function visibleTo(user, alert) {
    if (user.role !== 'owner') return true;
    return store.summary(alert.report_id)?.owner_email === user.email;
  }

  function publish(alert) {
    const event = { event_id: ++lastEventId, ...alert };
    history.push(event);
    if (history.length > historyCapacity) history.shift();
    for (const fn of subscribers) fn(event);
    return event;
  }

  return {
    // Feed one observation through the engine; returns the alerts published (possibly none).
    ingest(observation) {
      return engine.process(observation).map(publish);
    },

    // One alert by event id, or null when it never existed or has aged out of the bounded history.
    get: (eventId) => history.find((a) => a.event_id === eventId) ?? null,

    subscribe(fn) {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },

    streamId: () => streamId,
    lastEventId: () => lastEventId,
    oldestEventId: () => (history.length > 0 ? history[0].event_id : null),

    // Everything after `afterId` that this user may see, oldest first. `gap` is true when events the client missed
    // have already been dropped from the bounded history, so it should refetch state over REST.
    since(user, afterId) {
      const oldest = history.length > 0 ? history[0].event_id : lastEventId + 1;
      // A client "ahead" of the server can only have been talking to an earlier run of it.
      const ahead = afterId > lastEventId;
      const gap = ahead || afterId + 1 < oldest;
      return { alerts: history.filter((a) => a.event_id > afterId && visibleTo(user, a)), gap, ahead, oldest_event_id: history.length > 0 ? oldest : null };
    },

    // Newest first, filtered and role-scoped.
    list(user, { alertType, severity, lifecycle, reportId } = {}) {
      return history
        .filter((a) => visibleTo(user, a))
        .filter((a) => !alertType || a.alert_type === alertType)
        .filter((a) => !severity || a.severity === severity)
        .filter((a) => !lifecycle || a.lifecycle === lifecycle)
        .filter((a) => !reportId || a.report_id === reportId)
        .reverse();
    },

    active: (user) => engine.active().filter((a) => visibleTo(user, a)),
    stats: () => ({ ...engine.stats(), last_event_id: lastEventId, history_size: history.length, history_capacity: historyCapacity }),
    visibleTo,
  };
}
