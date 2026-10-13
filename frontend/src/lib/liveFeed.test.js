import { beforeEach, describe, expect, it } from 'vitest';
import { createLiveFeed, FEED_STATUS } from './liveFeed.js';

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closedWith = null;
    FakeWebSocket.instances.push(this);
  }
  send(data) { this.sent.push(JSON.parse(data)); }
  close(code) { this.closedWith = code; }
  // test helpers
  open() { this.onopen?.(); }
  receive(msg) { this.onmessage?.({ data: typeof msg === 'string' ? msg : JSON.stringify(msg) }); }
  drop(code = 1006) { this.onclose?.({ code }); }
}
const last = () => FakeWebSocket.instances.at(-1);

function setup(overrides = {}) {
  const timers = [];
  const calls = { status: [], alerts: [], gaps: [], authFailed: 0 };
  const feed = createLiveFeed({
    url: 'ws://test/ws',
    getToken: () => 'tok',
    WebSocketImpl: FakeWebSocket,
    onStatus: (s) => calls.status.push(s),
    onAlert: (a) => calls.alerts.push(a),
    onGap: (g) => calls.gaps.push(g),
    onAuthFailed: () => calls.authFailed++,
    schedule: (fn, ms) => { timers.push({ fn, ms, cancelled: false, fired: false }); return timers.length - 1; },
    cancel: (id) => { timers[id].cancelled = true; },
    random: () => 0.5,
    ...overrides,
  });
  // Run the most recent pending retry timer.
  const fire = () => { const t = timers.filter((x) => !x.cancelled && !x.fired).at(-1); t.fired = true; t.fn(); };
  return { feed, timers, calls, fire };
}
const alert = (id, extra = {}) => ({ type: 'alert', event_id: id, alert_type: 'LATENCY', severity: 'low', report_id: 'RPT_1', ...extra });

beforeEach(() => { FakeWebSocket.instances = []; });

describe('connecting', () => {
  it('sends the token in the first message, never in the URL, and goes live on "ready"', () => {
    const { feed, calls } = setup();
    feed.start();
    expect(calls.status).toEqual([FEED_STATUS.CONNECTING]);
    last().open();
    expect(last().sent).toEqual([{ type: 'auth', token: 'tok' }]);
    expect(last().url).not.toContain('tok');
    expect(new URL(last().url.replace('ws:', 'http:')).search).toBe(''); // no query string at all
    last().receive({ type: 'ready', last_event_id: 7 });
    expect(calls.status).toEqual([FEED_STATUS.CONNECTING, FEED_STATUS.LIVE]);
    expect(feed.lastEventId()).toBe(7);
  });

  it('delivers alerts in order and ignores ones it already has', () => {
    const { feed, calls } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 0 });
    last().receive(alert(1)); last().receive(alert(2)); last().receive(alert(2)); last().receive(alert(1));
    expect(calls.alerts.map((a) => a.event_id)).toEqual([1, 2]);
  });

  it('ignores malformed frames and unknown message types without crashing', () => {
    const { feed, calls } = setup();
    feed.start(); last().open();
    last().receive('{not json'); last().receive({ type: 'mystery' }); last().receive({ type: 'pong' });
    expect(calls.alerts).toEqual([]);
  });

  it('reports a gap notice to the app', () => {
    const { feed, calls } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 9 });
    last().receive({ type: 'gap', oldest_event_id: 5 });
    expect(calls.gaps).toEqual([{ type: 'gap', oldest_event_id: 5 }]);
  });

  it('with no token it gives up and reports an auth failure instead of looping', () => {
    const { feed, calls } = setup({ getToken: () => null });
    feed.start(); last().open();
    expect(calls.authFailed).toBe(1);
    last().drop(1000);
    expect(feed.status()).toBe(FEED_STATUS.UNAUTHORIZED); // the close event must not overwrite it with "stopped"
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe('reconnecting', () => {
  it('after a drop it waits, reconnects, and resumes from the last event id it saw', () => {
    const { feed, calls, timers, fire } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 0 });
    last().receive(alert(1)); last().receive(alert(2));
    last().drop(1006);
    expect(feed.status()).toBe(FEED_STATUS.RECONNECTING);
    expect(timers).toHaveLength(1);
    fire();
    expect(FakeWebSocket.instances).toHaveLength(2);
    last().open();
    expect(last().sent).toEqual([{ type: 'auth', token: 'tok', last_event_id: 2 }]);
    last().receive({ type: 'ready', last_event_id: 4 });
    last().receive(alert(3)); last().receive(alert(4));
    expect(calls.alerts.map((a) => a.event_id)).toEqual([1, 2, 3, 4]);
    expect(feed.status()).toBe(FEED_STATUS.LIVE);
  });

  it('a drop right after the first "ready" still resumes from the position the stream was at', () => {
    const { feed, fire } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 41 });
    last().drop(1006); fire(); last().open();
    expect(last().sent[0].last_event_id).toBe(41);
  });

  it('backoff doubles with each failed attempt, is capped, and is jittered', () => {
    const { feed, timers, fire } = setup({ random: () => 0 }); // lowest jitter: half of the raw delay
    feed.start();
    const delays = [];
    for (let i = 0; i < 8; i++) {
      last().drop(1006); // never opens, like a server that is down
      delays.push(timers.at(-1).ms);
      fire();
    }
    // raw delays 1s, 2s, 4s, 8s, 16s, then capped at 30s; the lowest jitter is half of each
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 15000, 15000, 15000]);
    const high = setup({ random: () => 1 });
    high.feed.start(); last().drop(1006);
    expect(high.timers.at(-1).ms).toBe(1000); // the full raw delay at the top of the jitter range
  });

  it('a successful "ready" resets the backoff', () => {
    const { feed, timers, fire } = setup({ random: () => 0 });
    feed.start();
    last().drop(1006); fire(); last().drop(1006); fire(); // two failures: the next delay would be 2000
    last().open(); last().receive({ type: 'ready', last_event_id: 0 });
    last().drop(1006);
    expect(timers.at(-1).ms).toBe(500);
  });

  it('coming back online skips the wait', () => {
    const { feed, timers } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 0 }); last().drop(1006);
    expect(FakeWebSocket.instances).toHaveLength(1);
    feed.notifyOnline();
    expect(timers[0].cancelled).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe('after the server restarts', () => {
  it('resets its position instead of dropping the new, lower-numbered alerts as duplicates', () => {
    const { feed, calls, fire } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 40, stream_id: 'aaaa' });
    last().receive(alert(41)); last().receive(alert(42));
    last().drop(1006); fire(); last().open();
    expect(last().sent[0]).toEqual({ type: 'auth', token: 'tok', last_event_id: 42, stream_id: 'aaaa' });

    // The server restarted: a new stream whose event ids start again from 1.
    last().receive({ type: 'ready', last_event_id: 0, stream_id: 'bbbb', resumed: true });
    last().receive({ type: 'gap', reason: 'restarted', oldest_event_id: null, last_event_id: 0 });
    last().receive(alert(1)); last().receive(alert(2));
    expect(calls.alerts.map((a) => a.event_id)).toEqual([41, 42, 1, 2]);
    expect(calls.gaps).toHaveLength(1);
    expect(feed.lastEventId()).toBe(2);
  });

  it('a restarted server that is already past the old position still starts the client from the new head', () => {
    const { feed, calls, fire } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 10, stream_id: 'aaaa' });
    last().drop(1006); fire(); last().open();
    last().receive({ type: 'ready', last_event_id: 60, stream_id: 'bbbb', resumed: true });
    expect(feed.lastEventId()).toBe(60); // not 10: ids 11-60 belong to a different run
    last().receive(alert(61));
    expect(calls.alerts.map((a) => a.event_id)).toEqual([61]);
  });

  it('on later reconnects it sends the new stream id, and a server without stream ids still works', () => {
    const { feed, fire } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 5, stream_id: 'aaaa' });
    last().drop(1006); fire(); last().open();
    last().receive({ type: 'ready', last_event_id: 0, stream_id: 'bbbb' });
    last().drop(1006); fire(); last().open();
    expect(last().sent[0].stream_id).toBe('bbbb');

    const old = setup();
    old.feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 3 });
    last().drop(1006); old.fire(); last().open();
    expect(last().sent[0]).toEqual({ type: 'auth', token: 'tok', last_event_id: 3 });
  });
});

describe('connections that should not be retried', () => {
  it.each([
    [4401, FEED_STATUS.UNAUTHORIZED],
    [4429, FEED_STATUS.BLOCKED],
    [1008, FEED_STATUS.ERROR],
    [1009, FEED_STATUS.ERROR],
    [1003, FEED_STATUS.ERROR],
  ])('close code %i ends in "%s" with no further attempts', (code, status) => {
    const { feed, timers, calls } = setup();
    feed.start(); last().open(); last().receive({ type: 'ready', last_event_id: 0 });
    last().drop(code);
    expect(feed.status()).toBe(status);
    expect(timers).toHaveLength(0);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(calls.authFailed).toBe(code === 4401 ? 1 : 0);
  });

  it('stop() closes the socket, cancels a pending retry, and nothing reconnects afterwards', () => {
    const { feed, timers } = setup();
    feed.start(); last().open(); last().drop(1006);
    feed.stop();
    expect(timers[0].cancelled).toBe(true);
    expect(feed.status()).toBe(FEED_STATUS.STOPPED);

    const second = setup();
    second.feed.start(); last().open(); const sock = last();
    second.feed.stop();
    expect(sock.closedWith).toBe(1000);
    sock.drop(1000);
    expect(second.timers).toHaveLength(0);
  });

  it('start() twice does not open two sockets', () => {
    const { feed } = setup();
    feed.start(); feed.start();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
