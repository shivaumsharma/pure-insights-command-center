// Replays the cleaned observations as a live telemetry stream. The source CSV has no clock, so event time comes from
// the synthetic timeline (D3); wall-clock pacing is just `eventsPerSecond`.
//
// When the data runs out the replay starts again with every timestamp shifted forward by one full span, so event
// time keeps increasing and the alert engine's cooldowns behave as they would on a feed that never ends.

const HOUR_MS = 60 * 60 * 1000;

export function createSimulator({ observations, onEvent, eventsPerSecond = 10, logger = console }) {
  if (observations.length === 0) throw new Error('Simulator needs at least one observation');
  const events = [...observations].sort((a, b) => (a.observed_at < b.observed_at ? -1 : a.observed_at > b.observed_at ? 1 : 0));
  const first = Date.parse(events[0].observed_at);
  const last = Date.parse(events[events.length - 1].observed_at);
  const spanMs = Math.ceil((last - first + 1) / HOUR_MS) * HOUR_MS; // whole hours, so shifted cycles line up with the originals

  let cursor = 0;
  let cycle = 0;
  let timer = null;

  function step() {
    const base = events[cursor];
    const event =
      cycle === 0
        ? base
        : {
            ...base,
            observation_id: `${base.observation_id}@c${cycle + 1}`,
            observed_at: new Date(Date.parse(base.observed_at) + cycle * spanMs).toISOString(),
          };
    cursor++;
    if (cursor === events.length) {
      cursor = 0;
      cycle++;
    }
    onEvent(event);
    return event;
  }

  return {
    step,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        try {
          step();
        } catch (err) {
          logger.error('Simulator step failed:', err);
        }
      }, Math.max(1, Math.round(1000 / eventsPerSecond)));
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
    isRunning: () => timer !== null,
    position: () => ({ cycle, index: cursor, total: events.length }),
    spanMs: () => spanMs,
  };
}
