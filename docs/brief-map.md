# Brief-to-deliverable map

Every requirement in Case Study 3 (Pure Insights Command Center) and where it is met. A blank or "planned" row is a known gap.
Status is only "done" when there is code and a test or a reproducible command behind it.

| # | Requirement from the brief | Where it is met | Evidence | Status |
|---|---|---|---|---|
| T1a | React frontend | `frontend/` (Vite, React, React Router): sign-in, overview, reports, report detail, alerts, costs, orphaned reports, data quality | 233 component, page and unit tests; checked in a real browser as admin, owner and viewer, with a phone-width pass on every page (no sideways scroll, targets of 44 px or more) | done |
| T1b | Node/Express backend | `backend/src/` (app, routes, store) | `backend/test/api.test.js` | done |
| T1c | Role-based access control | `routes/access.js`, `auth/middleware.js`; admin / owner / viewer | RBAC matrix test, scoping test, 9 mutation checks | done (API) |
| T1d | Monitor system health | `GET /api/health`, `GET /api/reports`; Overview and Reports pages | tests compare against independently computed counts; browser figures match | done |
| T1e | Monitor orphaned reports | `GET /api/orphans`, owner reassignment, Orphaned reports page with assign and undo | API and UI tests; browser: 13 orphans, $521,801.03; assigning one gives 12 / $469,203.97 and undo restores it | done |
| T2a | Alert in real time when load latency > 15 s | `backend/src/alerts/engine.js` (tiers over 15 s), pushed by `realtime/hub.js` | `alerts-engine.test.js`; every one of the 1,181 alerts matches a separate Python implementation (`validation/REPORT.md`) | done (backend) |
| T2b | Alert when an automated refresh fails | same engine: FAILED / TIMED_OUT, escalating to critical after 3 in a row | engine and real-data tests | done (backend) |
| T2c | WebSocket or SSE transport | WebSocket at `/ws`; token-in-first-message auth, role-filtered, reconnect with replay | `realtime.test.js` (21 tests over real sockets and HTTP) | done |
| T3a | SQL over simulated Snowflake `ACCOUNT_USAGE` logs | `sql/10_credit_attribution.sql`, simulated `QUERY_HISTORY` and `WAREHOUSE_METERING_HISTORY` | `cost-sql.test.js` (hand-worked fixtures) | done |
| T3b | Attribute credits to individual reports | `sql/10_credit_attribution.sql` | credits conserved per warehouse-hour (check R1) | done |
| T3c | Unit cost per active user view | `sql/11_unit_cost.sql` | fixture and real-data tests | done |
| D1 | Orphaned reports (`NaN` / `ORPHANED_REPORT`) | flagged, never dropped; report-level `is_orphaned`; API; reassignment | `clean.test.js`, `api.test.js` | done |
| D2 | Negative credit values | quarantined with a reason code (24 rows) | `pipeline.test.js`, ledger via `/api/quarantine` | done |
| D3 | Latency spikes up to 55 s | flagged and alerted: 1,470 breaching rows, 6 at the 55 s ceiling (critical); de-duplicated to 838 attention alerts | `pipeline.test.js`, `alerts-engine.test.js` | done |
| D4 | Active users vs AWS hosting cost discrepancies | `sql/14_views_vs_aws_cost.sql` (625 flagged; see D13); on the Costs page (admin): a chart of every reading's hosting cost against its views with the fleet average and the 3x band, and a table of the flagged readings; `GET /api/costs/aws-usage` and `/aws-mismatch` | `cost-real.test.js`, `aws-usage.test.js`; the chart's points are re-derived in `validation/REPORT.md` | done |
| R1 | Deliverable: runnable full-stack codebase on GitHub | this repo | `npm run test:all`, `npm run smoke`, `npm start`; CI workflow; first run on GitHub (Ubuntu, 2026-10-13) passed all three jobs | done |
| R2 | Deliverable: REST and WebSocket specification | `docs/api-spec.md` (REST, alert endpoints, WebSocket protocol, close codes, reconnect rules) | `api-spec.test.js`: the documented endpoints and the code's routes are identical, and each answers on a live server | done |
| R3 | Deliverable: Snowflake cost allocation SQL script suite | `sql/00_schema.sql`, `sql/10-14` | `npm run cost:build`; matches a Python re-derivation (`npm run validate`); run guide in `docs/snowflake-run.md` | done, **never run on real Snowflake** |

## Beyond the brief

| # | Addition | Why | Where | Status |
|---|---|---|---|---|
| E1 | AI explanations of alerts, validated against the data, with a human-review queue | The role is about validating AI output (decision D32) | `backend/src/triage/`, `frontend/src/pages/AiReview.jsx` | built and tested; run on a local 7B model (10 alerts), **no hosted model run** |
| E3 | Independent Python validation of every headline number, a findings log, and a Snowflake run guide | The role is about independently rerunning analytics and documenting discrepancies (decision D40) | `validation/`, `docs/validation-findings.md`, `docs/snowflake-run.md` | built; 68 checks pass; the SQL is checked statically as Snowflake SQL, but the Snowflake run itself is **not done** |
| E2 | Charts and a more visual interface: rings, bars, line, scatter, fleet map | A command center is read at a glance (decision D39) | `frontend/src/components/charts/`, `docs/design-system.md` | built and tested; presentation of existing data, no backend change |

## Evaluator rubric headings

| Heading | Current evidence |
|---|---|
| Full-stack web architecture | Tiered design (`architecture.md`); API with RBAC; React app served from the same origin with a strict CSP |
| Real-time alerting and telemetry | Engine, hub, replay and reconnect tested; live feed in the dashboard verified in a real browser |
| Cloud cost SQL attribution | Done and independently verified (Python re-implementation matches) |
| Code quality and system docs | 497 tests (240 backend, 257 frontend), both mutation-checked, plus 68 independent Python checks; decision log D1-D46; README, spec and design docs |

## Disqualifiers and rules

The brief states none. Self-imposed rules: no Everpure logo, imagery, copy or font files (`design-system.md`); no real credentials, only
demo accounts on synthetic data; dollar values are labelled illustrative until a real credit price is set.
