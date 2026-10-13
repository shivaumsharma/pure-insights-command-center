# Decision log

Newest decisions at the bottom of each phase. Each entry says what was decided, why, and what it costs.

## Phase 1: data layer

### D1. Plain Node 22, no dependencies, for the pipeline
The backend will be Node/Express, so the data layer uses the same runtime and the built-in `node:test`
runner. A hand-written CSV parser (`csv.js`) is about 60 lines and handles quotes, CRLF and BOM.
Cost: no pandas-style tooling. Benefit: nothing to install, and a reviewer can read every line.

### D2. Quarantine only what is untrustworthy; flag everything else
A row leaves the clean store only when a measurement cannot be trusted. Everything else stays and is flagged.

| Condition | Treatment | Reason |
|---|---|---|
| Negative Snowflake credits (24 rows) | **Quarantine** `NEGATIVE_CREDITS` | The brief asks for anomaly filtering; a negative cannot be attributed to a report. Small refunds or adjustments are the likely cause but the data does not say. |
| Non-numeric, negative or fractional-count values, missing `report_id`, wrong field count, exact duplicate rows | **Quarantine** (own reason code) | Not present in this file. Handled so a different extract does not silently corrupt results. |
| Missing owner (`nan`, empty) or `ORPHANED_REPORT` (242 clean rows) | **Flag** `is_orphan` | The report still costs money. Ownership is a finding to show, not a reason to hide the spend. |
| Refresh status `UNKNOWN` (98 clean rows) | **Flag** `status_unknown` | Unknown is not a failure, so it must not raise a failed-refresh alert. |
| Zero monthly views (4 rows) | **Flag** `zero_views` | All four still incur cost (idle spend). Unit cost per view is undefined and must be handled in the cost SQL. |
| Load time over 15 s (1,470 rows) | **Flag** `latency_breach` | Alert threshold from the brief. |
| Load time of exactly 55 s (6 rows) | **Flag** `latency_at_ceiling` | The maximum is exactly 55.0, which looks like a cap or timeout rather than a measurement. |
| Peak concurrent users above monthly views (91 rows) | **Flag** `concurrency_exceeds_views` | Implausible, but we cannot tell which of the two numbers is wrong. |

Nothing is deleted. `clean + quarantine = input` is asserted in tests and printed in the report.

### D3. Each row is one hourly observation of a report, on a synthetic timeline
The CSV has 2,000 rows for 100 reports (20 each, in strict `RPT_200 ... RPT_299` cycles) and **no timestamp**.
The k-th row of a report becomes its k-th hourly observation starting `2026-09-01T00:00:00Z`, with reports
offset 30 s apart within an hour. A quarantined row keeps its slot so later timestamps do not shift.
Why: Phase 4 needs an event stream to replay, and cost attribution needs hourly windows.
Cost: the timeline is invented. Do not present any trend over time as real.

### D4. Owner is a per-observation fact; "orphaned" means the latest observation has no owner
Every one of the 100 reports shows at least two different owners across its rows, and 94 mix known and
missing owners. So owner cannot be a stable report attribute. `reports.csv` therefore marks a report
`is_orphaned` when its **latest clean observation** has no usable owner (13 reports), and keeps
`last_known_owner_email` as the suggested assignee. 94 reports have at least one orphan observation.

### D5. Simulated Snowflake tables are derived from the CSV, and built so reconciliation is not circular
- `WAREHOUSE_METERING_HISTORY`: CSV credits summed per warehouse-hour. Totals equal the CSV **by construction**,
  so that match proves nothing.
- `QUERY_HISTORY`: elapsed time is `query_count x avg_load_time`. It is **independent of the credits column**.
  In Phase 2, splitting a warehouse-hour's credits across reports by query workload will therefore **not**
  reproduce each report's CSV credits. That gap is intended and is what the reconciliation page reports.
  The alternative (generating workload proportional to credits) would pass trivially and mean nothing.
- Deviation from real Snowflake: `QUERY_HISTORY` is one row per report per hour (with `query_count`), not one
  row per query. At about 12k queries per observation a per-query table would be roughly 25 million rows.
- `credits_used_cloud_services` is always 0; the source has no such split.
- Report to warehouse assignment is a stable hash over four warehouse names. It is invented.

### D6. The source data is statistically random; do not read business insight into it
Correlations across rows are about zero: views vs AWS cost -0.03, query count vs credits 0.01, views vs
concurrent users -0.03. Credits, cost and usage are independent per row. Any "insight" such as a
costly-but-unused report reflects the generator, not real behaviour. Findings should be presented as
demonstrations of the tool working, not as conclusions about the business.

### D7. Output is deterministic and committed
No timestamps or randomness in outputs; a test asserts two runs are byte-identical. `data/processed/` is
committed so a reviewer can inspect results without running anything.

### D8. This project is separate from any other attempt
Built from scratch in its own folder, without reading any existing implementation, so two independent outputs
can be compared.

## Phase 2: cost allocation

### D9. One set of SQL files, two engines: Snowflake in production, SQLite locally
The cost logic lives only in `sql/10-14*.sql`. `backend/src/warehouse/local-warehouse.js` loads the Phase 1 outputs
into in-memory SQLite (Node's built-in `node:sqlite`, no dependency) under the same schema names (`core`,
`sim_account_usage`) and runs those exact files. That gives tests on known inputs and lets the backend serve the same
numbers without a Snowflake account. To stay portable the scripts use only CTEs, window functions, range joins and
`COALESCE/ROUND/REPLACE/ABS`; a test bans the common dialect-specific constructs.
Limits, stated plainly:
- **The SQL has never run on real Snowflake.** Portability is by construction and by lint, not by execution.
- **SQLite returns NULL for division by zero; Snowflake raises an error.** The zero-view guard in `11_unit_cost.sql`
  therefore cannot be tested locally: removing it changes nothing here (a mutation check confirmed this). Review it by eye.
- Booleans are stored as 0/1 locally, so no script compares a boolean column; they compare the underlying numbers.

### D10. Credits are attributed by elapsed-time share within each warehouse-hour
Snowflake bills per warehouse-hour, not per query, so a report's cost has to be apportioned. Each hour's credits are
split across the queries that ran in it in proportion to `total_elapsed_time_ms`. Failed and timed-out queries keep their
share because they held the warehouse. Credits are conserved (check R1). Alternatives not used: splitting by query count
(ignores that queries differ in size) or by bytes scanned (not available in the source).

### D11. Unit cost definition and what it assumes
`cost per view = (attributed credits x price + AWS cost) / views`, pooled across a report's observations (ratio of sums,
not average of ratios, so one low-view observation cannot dominate). Each observation is treated as its own billing
period; views are not de-duplicated across observations because the source gives no overlap information, so a report's
"total views" is a sum of 30-day figures and should be read as a relative measure. Spend during zero-view observations
is reported separately as `idle_cost_usd`. **`credit_price_usd` is a placeholder (3.00) in `core.cost_params`. Do not
quote dollar totals until it is replaced with the contracted rate.**

### D12. Reconciliation is built so the circular check cannot masquerade as proof
`12_reconciliation_checks.sql` has eight checks. R1-R6 verify the plumbing (credits conserved, nothing dropped by the
joins). R7 compares attributed and CSV totals but is labelled INFO because the warehouse credits were built from the
CSV, so agreement is guaranteed. R8 is the real test: per-report attributed credits against what the CSV claims, with a
10% tolerance (a parameter). On this data **R8 fails for 64 of 100 reports**, by design (D5): the CSV's per-report credits
are independent of query workload. That is the finding the page reports, not a bug. If the credits had been generated
proportional to workload, R8 would pass and mean nothing.

### D13. AWS-versus-views mismatch is a prompt to investigate, and this definition flags a lot
Active users are approximated by `monthly_active_views`. An observation is flagged when its AWS cost is at least 3x (or
at most 1/3 of) what the fleet-average cost per view predicts, or when it has zero views but non-zero cost. On this data
that flags **625 of 1,976 clean observations (32%)**: 322 high, 299 low, 4 zero-view. That is a symptom of the data
(AWS cost and views are uncorrelated, D6), not of a precise detector. The threshold is a parameter; a real deployment
would calibrate it. AWS compute also scales with concurrency and data volume, which this definition ignores.

## Phase 3: REST API

### D14. Three roles; an Owner means "currently owns the report"
Admin sees everything; Owner sees health, detail and cost for reports whose current owner is them; Viewer sees health only, never cost.
Because owner is recorded per observation (D4), "currently owns" means the owner on the latest observation, or the admin's assignment
if one exists. Out-of-scope reports return 404, not 403, so report existence is not leaked. Authorisation is enforced on the server in
one small module (`routes/access.js`) and a role guard, never by hiding things in the UI.

### D15. Authentication choices and their limits
JWT (HS256, algorithm pinned, 8 h), scrypt password hashes, identical 401 for unknown user and wrong password, a decoy hash so both
take similar time, and a throttle of five failures per email and address per 15 minutes. Demo accounts live in
`backend/config/demo-users.json` (random passwords, marked demo-only) and are hashed at startup. **Not done, and fine for a local
demo:** refresh tokens, logout or token revocation, a shared store for the throttle (it is in memory and resets on restart), HTTPS
(terminate TLS in front), and CSRF (tokens are sent in a header, not a cookie).

### D16. The cost numbers are computed once at startup
The API runs the SQL suite when it boots and serves the results. That keeps requests fast and the numbers identical to
`npm run cost:build`. Changing the credit price or tolerances means editing `core.cost_params` defaults and restarting.
Dollar values are always returned with `price_is_placeholder: true`.

### D17. Owner reassignment is the only write, and it is an overlay
An admin can assign an owner to any report (including orphans). Assignments and an audit trail are saved in
`data/runtime/owner-assignments.json` (git-ignored); the source data is never modified. Removing an assignment returns the report to
the owner on its latest observation. Assigning to an email with no login still works: it simply has no one who can sign in as that owner.

### D18. Port 3101 by default, and a listen failure is fatal
Express 5 passes listen errors to the callback. The first version ignored it and printed "listening" while another process held the
port, so a test request reached the wrong server. The server now exits with a clear message on any listen error, and the default
port avoids the common 3001.

## Phase 4: real-time alerting

### D19. Alert rules and tiers
Latency over 15 s alerts (from the brief). Tiers: `low` over 15 s, `medium` over 25 s, `high` over 35 s, `critical` at 55 s or more
(the data tops out at exactly 55 s, which looks like a cap). A FAILED or TIMED_OUT refresh is `high`; three consecutive failures for a
report is `critical`. `UNKNOWN` raises and resolves nothing (D2). The tier edges are my choice, not from the brief.

### D20. Alert lifecycle: TRIGGERED, ESCALATED, REPEATED, RESOLVED, with a cooldown measured in event time
Per report and alert kind the engine announces the first breach, any worsening immediately, a reminder after a 6 h cooldown, and the
recovery. Everything else is counted as `suppressed_since_last` and attached to the next alert, so nothing is dropped silently.
Cooldowns run on observation timestamps, not wall-clock time, so a fast replay and a live feed behave identically and tests need no clocks.

### D21. Resolve only after two clear readings, and what that does and does not fix
The first design resolved on one clear reading. On this data (74% of readings breach, independently random per row) that produced
1,970 messages for 1,976 observations: reports flapped between triggered and resolved. Requiring two consecutive clear readings
cut resolutions from 738 to 343. I swept six settings (1-3 clear readings, 3 h and 6 h cooldown) in an independent Python model before
choosing; the choice (2 readings, 6 h) is a defensible operations cadence, not the minimum I could have picked.
**Result on the real data: 2,026 breaching readings produce 838 alerts that need attention (TRIGGERED, ESCALATED, REPEATED), i.e. 41%,
plus 343 resolutions; 143 conditions are still open at the end.** That is a modest reduction. It is limited by the data being
near-permanently "in alert", so the dashboard should lead with the active-alerts view and severity filters, not a pop-up per alert.

### D22. WebSocket design
Token in the first message, never the URL. Origin allowlist for browsers. Caps: 200 connections, 5 per user, 4 KB messages, 5 s to
authenticate. Server pings every 30 s and drops silent clients; sockets close when the token expires. Owners receive only alerts for
reports they own *at delivery time*, so a reassignment re-routes the next alerts immediately. In memory and single-process: a second
server instance would need a shared event log.

### D23. Reconnect semantics: a bounded event log with ids, and an explicit gap
Every published alert gets an increasing `event_id` and goes into a 2,000-alert ring buffer. A client reconnects with its last id and
receives exactly what it missed (role-filtered), once, in order; if the buffer has already dropped some of it the server says so with
a `gap` message and the client rebuilds from REST. Delivery is at-least-once from the client's point of view only if it reconnects with
the right id; the server does not track per-client acknowledgements.

### D24. The alert object's kind is `alert_type`, not `type`
The first version used `type` for LATENCY / REFRESH_FAILURE. On the wire the message envelope also has a `type` (`alert`, `ready`, ...),
and spreading the alert into the envelope silently overwrote it. Engine and service tests could not see this because it only exists in
the serialised message; the WebSocket integration tests caught it. A regression test now pins the envelope and required fields.

## Phase 5: web dashboard

### D25. Stack: Vite, React, React Router, nothing else at runtime
The brief names React. Beyond React and the router there are no runtime libraries: charts are one small SVG component, data fetching is
a 20-line hook, and the live feed is a framework-free module with every network and clock dependency injected, so reconnect, backoff,
resume and gap handling are tested exactly (17 tests) rather than by waiting on real sockets. The build is about 97 KB gzipped.

### D26. Where the token lives, and what the UI does and does not enforce
The JWT is kept in `sessionStorage` (this tab only, gone when it closes) and sent as a bearer header. Any script on the page can read it,
which is the standard trade-off for this pattern; the CSP (same-origin scripts only) is the mitigation, and tokens expire after 8 h.
The UI hides what a role cannot use and shows "No access" on direct URLs, but this is only to avoid dead ends: every restriction is
enforced by the server, and a real browser check confirmed a viewer's own token gets 403 on every admin endpoint.
The live feed sends the token in its first message, never in the address.

### D27. One origin: the server serves the UI, so the WebSocket origin check had to allow it
Serving the built app from the API server removes CORS and gives `npm start` as the whole product. The first version of the WebSocket
origin check only allowed the Vite dev server, so the app's own socket was refused in a real browser and the feed sat on
"Reconnecting" forever. No test had caught it because tests connect without an `Origin` header. Same-origin is now allowed (exact host
and port) and look-alike hosts, other ports and `Origin: null` are still refused (tested).

### D28. Accessibility: what was checked and what was not
Checked with real measurements, not assumptions: every text/background pairing (hover state and badges included) is asserted at 4.5:1
from the actual CSS tokens; a pressed primary button failed at 3.7:1 and was changed to keep its colour and add a border. In a real
browser: no sideways page scroll at 375 px on any page (wide tables scroll inside labelled, keyboard-reachable regions), every control
at least 44 px, one `h1` per page, labelled landmarks and fields, captioned tables, no heading-level jumps, correct current-page marker.
Severity and status are always words as well as colour. Motion respects `prefers-reduced-motion`.
**Not checked:** a screen reader, a keyboard-only walkthrough of every flow, high-contrast mode, or any browser besides the one in the
preview pane. There is no dark mode.

### D29. Live updates are throttled, and counts come from the server
Alerts arrive at up to 10 per second, so pages refetch their server-side lists at most every 2 s, and not at all while the tab is
hidden. The first version downloaded all open alerts (about 140 rows) every time just to count them by severity; the API now returns the
counts in `meta.by_severity` and the Overview asks for one row.

### What the UI deliberately does not do
- There is no review-queue workflow. The "Reports to review" list is a read-only view of reports whose claimed credits disagree with
  the usage logs; nothing can be marked reviewed. (The first architecture sketch showed a human review gate; that is not built.)
- No export, no saved views, no notifications outside the page, and no AI triage (left out unless you ask for it).

## Phase 6: continuous integration

### D30. What CI checks, and what it cannot prove yet
`.github/workflows/ci.yml` runs on every push to `main` and every pull request, with read-only permissions and no deploy step. Three jobs:
- **Backend:** `npm ci`, rebuild the generated data and fail if `data/processed` differs from what is committed (the pipeline is
  deterministic, so any difference means code or raw data changed without regenerating), then the backend tests and a dependency audit.
- **Frontend:** `npm ci`, the frontend tests, the production build, a dependency audit, and the build kept as an artifact.
- **Smoke:** starts the real server with the built UI on a free port with throwaway accounts, then checks the app shell and CSP, the
  asset caching, the 401 without a token, an admin sign-in and fleet health, a viewer's 403 on admin data, the deliberate reconciliation
  failure, a live alert over the WebSocket from the page's own origin, and the refusal of a foreign origin. `npm run smoke` runs it locally.

Third-party actions are pinned to the commit SHAs of their `v4` releases, so a moved tag cannot change what runs. `.gitattributes` forces
LF line endings so the generated-data check cannot fail on a Windows checkout.

How it was verified, honestly: the workflow parses as valid YAML and passes structural checks (pinned SHAs, timeouts, job and artifact
names, scripts exist), and the checker was shown to fail on six deliberately broken copies. Every step was replayed in a fresh copy of the
project with its own git repository, from a clean install. The smoke test was shown to fail when the WebSocket origin bug, a missing UI
build, or a viewer's access to costs was reintroduced.

**What is proven, and what is not:** the first run on GitHub (clean Ubuntu, 2026-10-13) passed all three jobs, so the Linux-only problems I worried
about (path case, shell differences) did not appear. It has run once; a single green run is not a track record. There is no linter configured, so there is no lint step. Branch
protection ("require CI to pass before merging") is a GitHub setting and has to be switched on there. The actions are not on an automatic
update schedule. `data/raw` holds the assessment's dataset and must be committed for CI to rebuild; confirm you are allowed to publish it.

### D31. Event ids restart with the server, so resuming needs a stream id
Found while writing the demo script, not by a test: alert event ids restart at 1 whenever the server restarts, but a reconnecting
client resumed from its old id and treated every new alert with a lower id as a duplicate. After a restart the live feed would have gone
silently quiet until ids caught up. Each server run now has a random `stream_id`, announced in `ready` and echoed by the client. A different
stream (or a position beyond the newest event) gets a `gap` with `reason: "restarted"` and no replay, because old ids mean nothing in the
new run, and the client resets its position and refetches its lists. Tested on each side, and end to end by `npm run smoke:restart`, which
restarts a real server under the real browser client and was shown to fail without the fix. It runs in CI.
Limit: alerts raised between the restart and the client's reconnect are not replayed; the refetch after the gap notice covers them.

## Phase 7: AI triage ("explain this alert")

### D32. Why this exists, and what it is not
The job description is about validating AI output: checking it against source data, tracing it to datapoints, and gating questionable
output behind a person. The brief itself has no AI task, so this is an addition chosen because of the role, and it was built after the
core and left out of the thesis line on purpose. The feature is "explain this alert and suggest next steps", with the AI as the writer and
the data as the judge. It never acts: suggestions are text for a person, and nothing is done automatically.

### D33. The gate: nothing reaches a person unless it checks out against the evidence
Every suggestion, from an AI or from rules, goes through one validator (`backend/src/triage/validator.js`):
- **Evidence pack:** numbered datapoints (the alert, the report up to that moment, fleet baselines, up to 8 recent readings). It is cut off
  at the alert's own reading, because the replay data is static and naive code would explain an alert using readings from its future.
  No emails, no report names and no cost data are in it.
- **Citations:** every claim cites evidence fields and the value it read. A cited item that does not exist, a field that does not exist,
  or a value that differs (even 41.3 for 41.2) makes the suggestion false.
- **Causes are mechanical:** each cause kind has a data rule (for example "high query volume" means the latest reading is at or above the
  fleet's busiest quarter). A cause the rule says is false is contradicted. A cause that cannot be tested (`OTHER`) goes to a person.
- **Prose is checked too:** numbers in the text must exist in the evidence, and links, markup, email addresses and instruction-like text are
  refused. Overconfidence, an unjustified action, or the suggestion asking for a person all route to review.
- **Verdicts:** `REJECTED` (false or fabricated), `NEEDS_REVIEW` (cannot be fully verified), `TRUSTED` (every check passed).
- **Who sees what:** everyone sees `TRUSTED`; a held suggestion shows non-admins only "under review"; a rejected one is withheld from
  everyone but admins. Admins decide held ones in an AI review queue. A contradicted suggestion can only be dismissed, never approved.
**"Trusted" means "checked against this evidence", not "true of the real world".** The evidence is what the data shows and nothing more.
The thresholds in `rules.js` are my choices, not from the brief.

### D34. What was measured, and what was not
- **Validator vs a corpus:** 28 hand-built hallucinations and mistakes (fabricated and wrong citations, contradicted causes, invented kinds,
  invented numbers, injected instructions, overconfidence, and more) are each caught with the right verdict and reason; a true suggestion
  is not flagged. These cases were written to be caught, so this shows the validator works on the failures I thought of, not on every
  way a model can be wrong. The validator was also mutation-checked (21 deliberate breakages, all caught after one test gap was closed).
- **Rule-based triager on all real alerts:** of 838 explainable alerts (the other 343 are resolutions), 721 have a data-supported cause and
  117 do not and are sent to a person; none are rejected. This was reproduced by an independent Python implementation of the alert engine
  and the rules, with matching per-cause counts (203, 210, 107, 567, 62).
- **One real model, once, small: a local qwen2.5:7b on 10 alerts (D38).** The checker rejected 8 of its answers and held 2; none passed.
  The rules passed 9 of the same 10.
- **NOT measured: the hosted (Claude) model.** There were no credentials here. Its adapter uses the official SDK with structured outputs and
  was tested against a fake client, but its request has never been accepted by the live API from this repository.
  `npm run triage:eval -- --llm --limit 20 --yes` would run it (paid, needs `ANTHROPIC_API_KEY`).

### D35. The AI path is opt-in, capped, and falls back to rules
`AI_PROVIDER=anthropic` (hosted) or `AI_PROVIDER=ollama` (local, D38) is required to use a model; a key in the environment alone does nothing, so data is never sent to a third party by
accident. What is sent: the evidence pack and the instructions only (never emails, names, costs or the key). Errors from the provider are
reported as plain codes and never repeat what the provider said. A cap on model calls per hour and a per-user rate limit bound spend, and
when the model fails, is refused, times out or the budget is spent, the rule-based triager answers instead and the result says so.
Model defaults to `claude-opus-5-5`, configurable with `AI_MODEL`. Results are cached per alert, so everyone gets the same answer.

### D36. Limits of the AI slice
Single process (the cache and rate limits are in memory); only review decisions are persisted; the evidence is from synthetic data; an AI
that is wrong in a way my rules cannot express will pass the validator; and the rule set is small (five testable causes). The UI shows
who wrote each explanation and whether it passed, so a reader never has to guess whether an AI was involved. One UI limit, found in the
browser: on a very busy feed an open explanation closes by itself. At 40 replayed readings a second it closed in under a second; at 2 a
second it stayed open for as long as I watched (17 s). The likely cause is the dashboard keeping only the newest 100 live alerts, so a
panel goes when its alert leaves that window, but I did not confirm the mechanism or measure the default rate. It affects only how long a
panel stays open, not what it says or whether it was checked.

### D37. The test suite is load-sensitive, so concurrency is bounded
Once the suite grew, a fixed-duration timer test and two server-starting files failed intermittently when files ran in parallel on a busy
machine. The timer test now waits for its condition, and `npm test` runs at most 4 files at once with a 60 s per-test timeout. Six
consecutive runs passed afterwards.

### D38. A free, local model: the Ollama adapter, and the first real measurement
The hosted path needs a paid key, so a second adapter (`backend/src/triage/ollama.js`) talks to a model running in Ollama on this computer:
free, no account, no key. It reuses everything else: the same prompt (`prompt.js`), the same response schema (sent as Ollama's `format`),
the same validator and the same fall back to rules. It is opt-in (`AI_PROVIDER=ollama`, model `AI_MODEL`, host `OLLAMA_HOST`, default
`http://localhost:11434`), uses temperature 0 so one alert gets one answer, a larger context window than Ollama's default, and a 120 s
timeout because a laptop is slow. The startup line says whether evidence stays on this computer, and warns when the host is somewhere else.
`npm run triage:eval -- --llm --provider ollama` measures it; it asks for `--yes` only when the host is not this computer.

**Result (qwen2.5:7b, a laptop with an RTX 3060, 10 alerts spread evenly over the 838 explainable ones, 0 failed calls):**
| Writer | Passed the checks | Held for a person | Rejected as false |
|---|---|---|---|
| qwen2.5:7b | 0 | 2 | 8 |
| llama3.1:8b (same 10 alerts) | 6 | 0 | 4 |
| gemma2:9b (same 10 alerts) | 3 | 0 | 7 |
| qwen2.5:1.5b (same 10 alerts) | 0 | 0 | 8 (and 2 answers cut off at the length limit, so the rules would have answered) |
| Rules (same 10 alerts) | 9 | 1 | 0 |

The 1.5B model failed in more ways than the 7B: it cited fields that do not exist (7 of 10 alerts), invented an evidence id, and had one
confidence outside 0 to 1, all caught. Its 8 completed answers were all rejected as false. A smaller model did worse, as expected, and still
nothing false was shown. The detail paragraphs below are for the Qwen 7B run.

**Llama 3.1 8B did far better: 6 of 10 passed the checks, 4 were rejected, 0 failed calls, median 16 s.** Its flags were a cause the data
contradicts (3 alerts), overconfidence (3), an action the evidence did not justify (1) and a field that does not exist (1); on the 9 alerts the
rules could explain, it reached an answer that passed on 6. Same machine, same 10 alerts, same prompt, so the gap between similar-sized
models is mostly the model, not the setup. **Gemma 2 9B, the largest of the four, passed only 3 of 10** (7 rejected: a cause the data contradicts in 7,
overconfidence in 5, a wrong cited value in 3; median 33 s). Size alone does not decide this: the ordering was Llama 8B, then Gemma 9B, then Qwen 7B, then
Qwen 1.5B. It is still 10 alerts each, so read it as "Llama is clearly better
here", not as a ranking with decimals.

I read one of its passing answers closely (the fixture alert). It was true: it named recurring slowness, cited the right values, and the claim holds.
But one of its three citations (O3, 12 s) is under the limit, so it does not support the sentence it was attached to. **The checker passed it
because it verifies that cited values are correct and that the cause passes its data test, not that every citation supports its claim.** That is a
real limit of the validator, so "passed" means "its numbers and its cause check out", not "every reference is apt". Tightening it (each citation
for a count claim must itself meet the cause's condition) is a possible next step, and I have not done it.

Why it was flagged (alerts per reason): cause contradicted by the data 6, overconfident 5, asked for a person 4, action not justified 3,
cited a wrong value 2, cause that cannot be tested 2, and one each for an unknown field, no relevant citation, an invented number and low
confidence. Median 20 s per alert; 13,301 tokens in, 3,970 out in all.

**How to read it.** Nothing false was shown: every answer the model got wrong was caught before a reader would see it, which is what the
checker is for. It says nothing more than that. It is 10 synthetic alerts, one 7B model and a prompt I did not tune, so it is not a claim
about AI in general, and I cannot say how a larger model would do. The flags are mechanical tests against my rules (D33), not a judgement
that the explanation was useless; I read one answer closely (the fixture alert: it wrote conditions such as ">= 41.2" where it was told
to copy values, compared unrelated fields, claimed causes the data contradicts, and stated confidence 1) and not the other nine. Because no
answer passed, this run cannot show whether the checker ever TRUSTS something false; the 28-case corpus and the mutation checks speak to
that, and only for the failures I thought of. A model-side reason it did badly could be the strict "copy the value exactly" format; I did
not test that.

**Checked.** 16 tests against a stand-in HTTP server that mimics Ollama's chat endpoint (real HTTP, timeouts and refused connections), and
20 deliberate breakages of the adapter, config and provider choice, all caught. The adapter was also run against the real local Ollama,
which is where the result above comes from. **Not done:** the hosted Claude model (out of scope now that the local path exists), model sizes above 9B, other model families, prompt tuning.

## Phase 8: charts and a more visual interface

### D39. Charts that show data the API already serves
The interface was mostly tables and numbers. The case study's deliverable is a command center, and a command center is read at a glance, so
charts were added (rings, bars, line, scatter, a fleet map) and the layout made more visual (icons, meters, severity edges, a two-row top bar).
This is **presentation of existing data, not a new capability**: no backend change, no new endpoint, no new dependency. Each chart reads an
endpoint the page already used or one the API already had (`/api/reports`, `/api/costs/reports` and `/api/costs/variance` with `limit=200`
return all 100 reports in one request, and `/api/alerts/summary` for admins). It was built after the core, so it is listed under "beyond the
brief" (E2) and kept out of the README's first lines.

Choices and why:
- **Hand-built SVG and CSS, no library.** A charting library is a dependency to audit and a larger bundle for six simple shapes, and the strict
  content-security policy rules out libraries that inject styles. The cost is that every chart is my code to test (see below).
- **Role rules unchanged.** Cost charts need cost access (admin, owner); the alert-noise card and the claimed-against-implied plot are admin only;
  a viewer's page makes no cost or admin request and shows no dollar figure (checked in a browser and in tests).
- **Not colour alone, and a table behind the cost chart** (see `design-system.md`).
- **Navigation.** First a two-row top bar (seven links with icons did not fit beside the account area); later replaced by a side menu (D41).

What it shows and does not:
- **Alert noise** uses counters since the server started, and the replay loops the same synthetic data, so the totals keep growing. The ratio
  (about 60% of breaching readings held back as repeats) is the useful number, not the totals.
- **The scatter** makes the synthetic-data finding visible: claimed and implied credits are unrelated, so most reports sit off the diagonal. It is not
  evidence about any real report.
- **Spend charts** use the placeholder credit price, as everywhere else (the banner stays).
- **Hover titles** are the browser's own, so they do not appear on touch screens. The numbers are always also in text, and the table is one tap away.

Checked: 85 new tests (maths, summaries, each component, each page including which requests each role does not make), 33 deliberate breakages of
the chart code all caught (one survived at first, because an assertion matched a wrong value by coincidence; fixed), contrast tests for every chart
colour, and a real-browser pass at phone width on all eight pages (no sideways scroll, no touch target under 44 px, every chart named).
**Not checked:** the screenshots available while building were limited to an 800 px window, so the wide layout (1,280 px) was verified by
measurement (the seven links fit on one row, paired cards sit side by side, no overflow) and by an early look at the overview, not by looking at
every page at that width. No dark mode, and no chart was tested with a screen reader (only for having a name and text).

## Phase 9: validation, a new look, currency

### D40. The independent validation ships in the repo
The README said headline numbers had been "recomputed independently in Python". That was true, but the scripts lived only in my scratch folder, so
a reviewer could not reproduce the claim: an evidence-honesty gap. `validation/validate.py` fixes it. It reads the **raw CSV** and, with its own
code (standard library only, nothing shared with the JavaScript or the SQL), re-derives the cleaning, every alert, the credit attribution, cost per
view, the variance check, the hosting-cost flags and the rule-based explanations, and compares each with what the app produced (the real alert
engine via `scripts/dump-app-results.mjs`, and the SQL suite's output files). `npm run validate` writes `validation/REPORT.md` (68 checks, all
passing) and exits 1 on any difference. It also checks every number the README quotes, so a stale README fails the run. It runs in CI.

It is not a new feature: it is the evidence for claims the project already made, and it is the job description's own task (rerun the analytics
independently, compare with source data, document the result repeatably) applied to this project.

Checked: I changed the alert cooldown, a severity tier, the number of clear readings, the critical failure streak, two explanation rules, an
owner in the clean data, a cost figure, a variance status, an AWS-mismatch row, a set-aside row and two README numbers in a throwaway copy; all 13
made it fail with a message that says what differs. **Limits:** the same author wrote both sides from the same written rules, so it catches slips and
drift, not a wrong reading of the brief; the SQL was compared through its SQLite stand-in, never on Snowflake. Two companion documents come with it:
`docs/validation-findings.md` (each data issue: evidence, impact, who to route it to, next step) and `docs/snowflake-run.md` (how to run the SQL on
a real account in about 20 minutes, with the values it should return).

### D41. A new look, from a reference the owner supplied
The first interface used the Everpure site's cream canvas, a dark top bar and condensed uppercase headings. The owner then supplied a public
dashboard concept (dribbble.com/shots/25605570) as a reference and asked that the result not look AI-generated. What was taken from it is layout
and manner, not assets or copy:
- **A white side menu with grouped items** (Monitor, Money, Validate), the current page marked by an orange bar on its edge, the account at the bottom.
  On a phone it becomes a bar across the top.
- **Soft white cards on a light neutral canvas**, a quiet shadow, tables with a plain header and a hover row instead of stripes.
- **Charts in the same manner**: a smooth orange curve over a gradient fill with a dark tooltip (mouse, touch or arrow keys), orange paired with
  near-black for two-part splits, a pill-shaped "Last 10 | All" switch, the dollar sign in the accent colour on the main spend figure.
What was removed because it reads as generated: the glowing gradient sign-in page, tinted rounded squares behind every icon, condensed uppercase
headings (everything is Inter now), the orange flourish above each title.

Choices the reference did not decide: the canvas is a warm light grey rather than the reference's cooler one, to stay near the Everpure palette; the
chart orange is `#e8601c`, because the brand orange `#ff7023` is 2.8:1 on white and graphics need 3:1 (the deeper one is 3.4:1); the muted text colour
is slightly darker than before for the same reason. All pairings are tested (`contrast.test.js`).
**Checked:** 25 deliberate breakages of the new code (tooltip by mouse, touch and keyboard, the menu groups per role, the readings switch, the smooth line,
currency): 24 caught after two test gaps were closed (the smoothing limiter, the chart tone); the 25th, an explicit flat-segment guard, is redundant
by construction (flat segments already get zero tangents), so removing it changes nothing.
**Limits:** the reference's other widgets (a gauge, a card list, quick links) were not reproduced; there is no dark mode; colour-blind simulation was
not run (status is also a symbol, so it should not matter, but I did not test it); the wide layout was checked with scaled screenshots and measurements.

### D42. Money is in US dollars
The owner asked that money follow the dataset: dollars if the data has dollars, otherwise rupees. The supplied file's cost column is
`aws_hosting_cost_usd`, so **everything is dollars**. Snowflake credits are a unit, not a currency; they are converted at a placeholder $3 per credit
(`core.cost_params`), and every page that shows dollars says so. All formatting goes through one function (`fmtUsd`) and a test pins it to US
dollars. I did not convert to rupees: that would need an exchange rate the data does not contain, and a made-up rate would be a worse number than none.

### D43. The API spec cannot drift from the code
`backend/test/api-spec.test.js` compares the endpoints written in `docs/api-spec.md` with the routes declared in `backend/src/routes`, in both
directions, and calls every documented endpoint on a running server to confirm it exists. Changing a route's path in the code makes it fail. It checks
that paths and methods agree, not that every field of every response is documented.

### D44. The SQL is checked statically as Snowflake SQL, because no account was available
The owner's Snowflake trial had expired, so the suite could not be run there (`docs/snowflake-run.md` stays as the way to do it). The next best
evidence is a static one, added to `npm run validate` (`validation/sql_static.py`, using the open-source `sqlglot` parser, pinned in
`validation/requirements.txt`): (1) every script parses in Snowflake's dialect; (2) every table and column the query scripts use is looked up in the
schema defined by `00_schema.sql` (script 10's output columns become the table that 11 to 14 read), including a check that every table exists, which the
library does not do by itself; (3) each generated CSV is matched to the table it would be loaded into, column for column and in order, since a mismatch
there would load the wrong data without an error; (4) four self-tests show the checker rejects a mistyped keyword, a misspelt column and an unknown
table, and accepts a correct query. It runs in CI inside a virtual environment, where a missing package is a failure; locally it is skipped with a note.

Checked: six deliberate mistakes in a copy of the SQL (a misspelt column, an unknown table, a lost bracket, two schema renames, a mistyped keyword),
each caught by this check on its own with a message that names the problem.

**What it does not show.** It runs nothing. It cannot show that Snowflake accepts every function and type as the parser does, or that the results
are right. The parser is lenient: it accepted an empty `PARTITION BY`, which is not valid, so a pass means "no typos, mismatches or malformed structure
that the parser can see", not "valid on Snowflake". The honest claim is: written in a portable subset, tested on SQLite with hand-worked fixtures,
re-derived independently in Python, checked statically as Snowflake SQL, and never run on Snowflake.

### D45. Showing the hosting-cost discrepancy, and explaining the checks in plain words
Two things the owner asked for after looking at the Costs page.
- **A chart for the hosting-cost discrepancy.** The brief names "discrepancies between active user counts and AWS hosting compute costs", and the table
  of flagged readings did not show the shape of it. The Costs page now plots every reading (views across, hosting cost up) with the fleet average cost per
  view as a solid line and the 3x and 1/3 lines as dashed ones, flagged readings as diamonds. It needs every reading, not a page of them, so there is
  one new admin endpoint, `GET /api/costs/aws-usage` (documented in the API spec; a test fails if the spec and the routes disagree). The flags are the SQL's
  own; only the fleet rate is recomputed in the route, and a test shows it is the rate script 14 used. The Python validator re-derives the rate and
  every point. "Active users" are still approximated by monthly active views.
- **Each reconciliation check says what it is and why it exists.** The page showed the SQL's terse wording ("Attributed = metered credits in every
  warehouse-hour with queries"), which read as eight similar checks. Each now leads with a plain name and a one-sentence reason (`lib/checkCopy.js`), and a test
  fails if the SQL defines a check the page does not explain. They are my own quality checks on the attribution, not something the brief asks for: R1 and R8 are
  the ones that matter, R2 to R5 each guard against a different way a join could silently lose rows, R6 repeats the cleaning step, and R7 is circular.

Also recorded here: the brief says "anomaly filtering", so I tested statistical detection on the raw file. Every numeric column is spread evenly across its
range and has **no** outlier by the 1.5x IQR or 3-standard-deviation tests, and the 24 negative credit values would not be flagged by either. They are caught by
a rule because credits cannot be negative (finding F13).
Checked: 17 deliberate breakages of the new code (scales, line clipping, mark size, legend, plain-language copy, admin gating, counts, the endpoint, its
paging, its role check, its documentation); one survived at first because the test fixture was symmetric, and was fixed.

## Open assumptions (to confirm in later phases)
- `sql/00_schema.sql` and `sql/10-14*.sql` have not been run against a live Snowflake account.
- `credit_price_usd`, `variance_tolerance_pct` (10) and `aws_mismatch_ratio` (3) are placeholders, not agreed business values.
