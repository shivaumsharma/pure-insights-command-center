# API specification

Base URL `http://localhost:3101` (set `PORT` to change). All API routes are under `/api`, return JSON, and use one error shape.
This document covers the REST API (Phase 3). The WebSocket section is added in Phase 4.

```
{ "error": { "code": "FORBIDDEN", "message": "You do not have permission to do this", "details": { } } }
```

| Status | `code` | Meaning |
|---|---|---|
| 400 | `BAD_REQUEST` | Invalid query parameter, body or id |
| 401 | `UNAUTHENTICATED` / `INVALID_CREDENTIALS` | No, bad, expired or forged token / wrong email or password |
| 403 | `FORBIDDEN` | Signed in, but the role may not do this |
| 404 | `NOT_FOUND` | Unknown route or report, or a report outside an Owner's scope |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 10 KB |
| 429 | `TOO_MANY_ATTEMPTS` | Five failed sign-ins for one email and address in 15 minutes; see `Retry-After` |
| 500 | `INTERNAL` | Generic message only; the detail is logged server-side |

## Authentication

`POST /api/auth/login` with `{ "email", "password" }` returns `{ token, token_type: "Bearer", expires_in, user }`.
Send `Authorization: Bearer <token>` on every other request. Tokens are HS256 JWTs (default lifetime 8 h) carrying only email and
role; the algorithm is pinned on verification. Wrong password and unknown email return the same 401. `GET /api/auth/me` returns the
signed-in user. `GET /healthz` is an unauthenticated liveness check that returns no data.

## Roles

| Role | Can do |
|---|---|
| `admin` | Everything, including reconciliation, quarantine, orphans, audit, and reassigning owners |
| `owner` | Health, list, detail and cost for the reports they currently own, and nothing else |
| `viewer` | Fleet health and report health, read-only. No cost data of any kind |

## Endpoints

List endpoints take `limit` (1-200, default 50) and `offset` (default 0) and return `{ data, page: { limit, offset, total } }`.
Responses that include dollars add `meta: { credit_price_usd, price_is_placeholder: true }`: **the credit price is a placeholder,
so treat dollar totals as illustrative**.

| Method and path | Roles | Notes |
|---|---|---|
| `GET /api/health` | all | Fleet counts: reports by latest refresh status, orphaned, refresh success and failure rates, latency breaches over 15 s. For an Owner it covers only their reports (`scope: "owned"`) |
| `GET /api/reports` | all | Filters `status`, `orphaned`, `q` (id or name); `sort` = `report_id` (default), `latency`, `failures`, `breaches`, `cost` (not for viewers); `order`. Ties break by id. Admin and Owner rows include `cost` |
| `GET /api/reports/:id` | all | Summary, up to 20 recent observations (newest first), and `cost` for Admin and Owner. An Owner asking for someone else's report gets 404 |
| `GET /api/costs/reports` | admin, owner | Cost per report and per view, idle spend. `sort` = `total_cost`, `cost_per_view`, `idle_cost`; `orphaned` |
| `GET /api/costs/reconciliation` | admin | Checks R1-R8 with `summary: { pass, fail, info }` |
| `GET /api/costs/variance` | admin | Attributed vs CSV-claimed credits per report; `status` filter |
| `GET /api/costs/aws-mismatch` | admin | Observations whose AWS cost does not fit their views; `type` filter |
| `GET /api/costs/aws-usage` | admin | **Every** reading's views and hosting cost with its flag (`mismatch_type`, null when within the band), unpaged, for the usage-against-cost chart. `meta` has `fleet_aws_per_view` (total hosting cost over total views, readings with views only) and `mismatch_ratio` (3) |
| `GET /api/orphans` | admin | Reports with no current owner, costliest first, plus `meta.orphaned_spend_usd` |
| `PUT /api/reports/:id/owner` | admin | Body `{ "email" }`. Assigns an owner; recorded in the audit trail |
| `DELETE /api/reports/:id/owner` | admin | Removes the assignment (back to the owner on the latest observation) |
| `GET /api/quarantine` | admin | Rows removed by cleaning, with reason codes; `reason` substring filter |
| `GET /api/dq-report` | admin | The data-quality report |
| `GET /api/audit` | admin | Owner assignments, newest first |

Cost endpoints serve the output of the SQL suite in `sql/` (see `cost-allocation.md`), computed once at startup.

## Alert REST endpoints

Same objects the WebSocket pushes. Admin and Viewer see all alerts; an Owner sees alerts only for reports they own at the moment of the request.

| Method and path | Roles | Notes |
|---|---|---|
| `GET /api/alerts` | all | History, newest first. Filters `alert_type` (`LATENCY`, `REFRESH_FAILURE`), `severity`, `lifecycle`, `report_id`. `meta` has `last_event_id` and `oldest_event_id`, the range still held in memory |
| `GET /api/alerts/active` | all | Conditions open right now, worst first. `meta.by_severity` counts everything the caller may see (`critical`, `high`, `medium`, `low`), not just the page, so a dashboard can ask for `limit=1` |
| `GET /api/alerts/summary` | admin | Readings processed, breaches, alerts emitted per lifecycle, readings held back |

### Alert object

```json
{ "event_id": 42, "alert_type": "LATENCY", "lifecycle": "ESCALATED", "severity": "high",
  "report_id": "RPT_201", "report_name": "Analytics Dashboard 2", "observation_id": "RPT_201:004",
  "observed_at": "2026-09-01T03:00:30.000Z", "suppressed_since_last": 2,
  "value": 41.2, "threshold": 15, "message": "RPT_201 (Analytics Dashboard 2) load time 41.2 s is over 15 s (high)" }
```

`lifecycle`: `TRIGGERED` (first time), `ESCALATED` (worse than the last alert, sent immediately), `REPEATED` (still true after the
6 h cooldown), `RESOLVED` (two consecutive clear readings). `suppressed_since_last` is how many readings were held back since the
previous alert for the same report and kind. Refresh-failure alerts carry `value` = the status and `consecutive_failures`;
`RESOLVED` alerts carry `active_for_ms`. Times are event time (see decision D3), not wall-clock time.

Severity: load time over 15 s is `low`, over 25 s `medium`, over 35 s `high`, 55 s or more `critical`. A failed or timed-out refresh
is `high`, and three in a row is `critical`. `UNKNOWN` status raises nothing and resolves nothing.

## WebSocket: `ws://localhost:3101/ws`

Messages are JSON text frames. The browser's built-in client cannot set headers, and a token in the URL would leak into logs, so the
token is sent in the **first message**.

```
client  ->  { "type": "auth", "token": "<jwt>", "last_event_id": 41, "stream_id": "9f3a1c2e" }   last two are optional
server  ->  { "type": "ready", "user": {...}, "last_event_id": 57, "stream_id": "9f3a1c2e", "server_time": "...", "resumed": true }
server  ->  { "type": "gap", "reason": "dropped" | "restarted", "oldest_event_id": 50, "last_event_id": 57, "message": "..." }   only if needed
server  ->  { "type": "alert", "event_id": 42, "alert_type": "LATENCY", ... }                 missed alerts, oldest first, then live
client  ->  { "type": "ping" }       server  ->  { "type": "pong", "server_time": "..." }
server  ->  { "type": "error", "code": "...", "message": "..." }                              then the socket closes
```

**Reconnecting.** Remember the highest `event_id` you processed and the `stream_id` from `ready`. On reconnect send it as `last_event_id`: you receive exactly the
alerts you missed (only those your role may see), in order, each once, followed by live alerts. If `gap` arrives, some events were
dropped from the bounded history (2,000 alerts); refetch `GET /api/alerts` and `GET /api/alerts/active` to rebuild state. Reconnect
with exponential backoff and jitter. Omit `last_event_id` on a first connection to get live alerts only.

**Server restarts.** Event ids start again from 1 whenever the server restarts, so an id is only meaningful within one run, which is
what `stream_id` names. If the `stream_id` you send is not the current one (or your `last_event_id` is beyond the newest event), the server
sends `gap` with `reason: "restarted"` and replays nothing. Reset your position to the `last_event_id` in `ready` and refetch
`GET /api/alerts` and `GET /api/alerts/active`. A client that ignored this would treat every new alert as one it had already seen.

**Close codes.** `4401` not authenticated, bad or expired token, auth timeout (5 s), or the token expired while connected;
`4429` too many connections for this user (5); `1008` invalid message (e.g. bad `last_event_id`) or too many bad messages;
`1003` binary frame; `1009` message over 4 KB; `1001` server shutting down. The server pings every 30 s and drops clients that do not answer.

**Handshake.** `/ws` only. A browser `Origin` is accepted when it is the same origin as the server (the normal case, because the server
also serves the UI) or is listed in `ALLOWED_ORIGINS` (default: the Vite dev server); anything else is refused with 403, including
look-alike hosts, other ports and `Origin: null`. Clients that send no `Origin` header (scripts, tests) are allowed, because the token
is what authenticates. Behind a reverse proxy that rewrites `Host`, add the public origin to `ALLOWED_ORIGINS`.

**Telemetry source.** The server replays the cleaned observations at `REPLAY_EVENTS_PER_SECOND` (default 10) through the alert
engine, then loops with timestamps shifted forward. Set `REPLAY_ENABLED=false` to disable it.

## AI triage ("explain this alert")

Explanations are written by a hosted model (`AI_PROVIDER=anthropic`), a model on this computer (`AI_PROVIDER=ollama`) or by rules (the default), and every one is checked against the data before anyone sees it
(decision D33). Resolved alerts have nothing to explain.

| Method and path | Roles | Notes |
|---|---|---|
| `GET /api/alerts/:eventId/triage` | all (for alerts they may see) | Generates on first request, then cached. 404 for an alert outside the caller's scope, 400 for a resolved alert, 429 when asked too often (10 new explanations per minute per user) |
| `GET /api/triage/review` | admin | Suggestions held for a person; `state` = `pending` (default), `approved`, `dismissed`, `all` |
| `POST /api/triage/:eventId/review` | admin | Body `{ "decision": "approve" \| "dismiss", "note"?: string }`. 409 if already decided, or if you try to approve one that contradicts the data |
| `GET /api/triage/stats` | admin | Verdict counts, why suggestions were flagged, the AI against the rule-based control on the same alerts, tokens and fallbacks |

`data.status` is what this caller sees: `TRUSTED` (passed every check), `APPROVED` (held, then approved by an admin), `UNDER_REVIEW` (held;
no content for non-admins), `WITHHELD` (contradicted the data; no content for non-admins), `DISMISSED`. When shown, `suggestion` holds
`summary`, `causes[]` (a fixed kind, a claim, `cites[]` of `{ evidence, field, value }`, confidence) and `actions[]`, and `evidence` holds the
numbered datapoints the citations point at. Admins also get `validation`, `findings[]` (code, severity, message, where) and `review`.
`triager` is `baseline` (rules), `anthropic` (hosted model) or `ollama` (local model); `model` names it. `fallback` (`{ "from": "<triager>" }`) is
present when the model failed and rules answered; the reason is kept server-side and counted in the stats.

## Serving the web app

If `frontend/dist` exists (`npm run web:build`), the same server serves it: any page address returns the app shell, `/api`, `/ws` and
`/healthz` are never answered with HTML, and hashed files under `/assets` are cached for a year while everything else is `no-store`.
HTML responses carry a Content-Security-Policy (same-origin scripts only; fonts and styles from Google Fonts; `connect-src` allows the
WebSocket), `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`. Override the folder with `STATIC_DIR`.

## Running it

```bash
npm run data:build                         # once
npm run web:install && npm run web:build   # once, to serve the UI
npm start                                  # http://localhost:3101 (UI, API and WebSocket on one address)
```

Demo accounts (one admin, two owners, one viewer) are listed in `backend/config/demo-users.json`, marked demo-only. Set
`JWT_SECRET` (32+ characters) to keep tokens valid across restarts; without it a random secret is used per run, and production
mode refuses to start without one.
