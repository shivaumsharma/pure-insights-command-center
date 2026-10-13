# Independent validation report

Produced by `npm run validate` (`validation/validate.py`). Every figure below was re-derived from the raw CSV by code that shares nothing
with the app, then compared with what the app produced. A `FAIL` means the two disagree and one of them is wrong.

**68 of 68 checks passed.**

## 1. Cleaning the raw CSV

Raw file -> clean readings, set-aside rows and owners. The app side is `npm run data:build`.

| Check | Independent (Python) | App | Result |
|---|---|---|---|
| rows received | 2,000 | 2,000 | PASS |
| rows used | 1,976 | 1,976 | PASS |
| rows set aside | 24 | 24 | PASS |
| every row accounted for (used + set aside = received) | 2,000 | 2,000 | PASS |
| set-aside reasons | {"NEGATIVE_CREDITS": 24} | {"NEGATIVE_CREDITS": 24} | PASS |
| the set-aside ledger lists the same rows with the same reasons | `{"92": "NEGATIVE_CREDITS", "197": "NEGATIVE_CREDITS", "394":` | `{"92": "NEGATIVE_CREDITS", "197": "NEGATIVE_CREDITS", "394":` | PASS |
| every clean reading matches field by field (id, owner, status, time, numbers, orphan kind) | 0 differ | 0 differ | PASS |
| reports | 100 | 100 | PASS |
| reports with no owner on their latest reading | 13 | 13 | PASS |
| readings with no usable owner | 242 | 242 | PASS |
| readings over 15 s | 1,470 | 1,470 | PASS |
| readings at the 55 s ceiling | 6 | 6 | PASS |
| numeric columns with a value beyond 1.5 x IQR (a statistical outlier) | `[]` | `[]` | PASS |
| numeric columns with a value more than 3 standard deviations from the mean | `[]` | `[]` | PASS |
| negative credit values a statistical outlier test would flag (a rule catches them, statistics does not) | 0 | 0 | PASS |

## 2. Alerts

Every alert, compared one by one in order. The app side is the real alert engine run over the processed data.

| Check | Independent (Python) | App | Result |
|---|---|---|---|
| number of alerts (including resolutions) | 1,181 | 1,181 | PASS |
| every alert matches: id, time, report, kind, stage, severity, repeats held back | 0 differ | 0 differ | PASS |
| alerts at stage TRIGGERED | 486 | 486 | PASS |
| alerts at stage ESCALATED | 203 | 203 | PASS |
| alerts at stage REPEATED | 149 | 149 | PASS |
| alerts at stage RESOLVED | 343 | 343 | PASS |

## 3. Cloud cost attribution

Credits split across queries by elapsed-time share, then cost per view. The app side is the SQL suite (sql/10-14) run on its SQLite stand-in.

| Check | Independent (Python) | App | Result |
|---|---|---|---|
| reports costed | 100 | 100 | PASS |
| every report: attributed credits, total cost, cost per view, idle spend, views, readings | 0 differ | 0 differ | PASS |
| the five most expensive reports, in order | `["RPT_299", "RPT_260", "RPT_254", "RPT_201", "RPT_258"]` | `["RPT_299", "RPT_260", "RPT_254", "RPT_201", "RPT_258"]` | PASS |
| credits are conserved (attributed total = metered total) | 1206352.48 | 1206352.48 | PASS |
| reports whose claimed credits are outside 10% of what their queries imply | 64 | 64 | PASS |
| the same reports are flagged | `["RPT_200", "RPT_201", "RPT_203", "RPT_204", "RPT_207", "RPT` | `["RPT_200", "RPT_201", "RPT_203", "RPT_204", "RPT_207", "RPT` | PASS |

## 4. Hosting cost that does not fit usage

Readings whose AWS cost is far from what their views predict (3x either way, or cost with no views).

| Check | Independent (Python) | App | Result |
|---|---|---|---|
| readings flagged | 625 | 625 | PASS |
| the same readings, with the same reason | `{"RPT_209:001": "COST_LOW_FOR_USAGE", "RPT_211:001": "COST_H` | `{"RPT_290:007": "COST_HIGH_FOR_USAGE", "RPT_205:005": "COST_` | PASS |
| the chart's fleet hosting cost per view (the average line) | 0.305675184 | 0.305675184 | PASS |
| the chart's points: every reading's views, hosting cost and flag | 0 differ | 0 differ | PASS |

## 5. Rule-based explanations

For each alert that is not a resolution: which causes the data supports, using only readings up to that alert.

| Check | Independent (Python) | App | Result |
|---|---|---|---|
| alerts explained | 838 | 838 | PASS |
| the set of causes matches for every alert | 0 differ | 0 differ | PASS |

## 6. The numbers quoted in the README

Each figure the README states, recomputed here. If one moves, update the README.

| Check | Independent (Python) | App | Result |
|---|---|---|---|
| rows received | 2,000 | 2,000 | PASS |
| rows used | 1,976 | 1,976 | PASS |
| rows set aside (all: negative credits) | 24 | 24 | PASS |
| reports | 100 | 100 | PASS |
| reports with no owner now | 13 | 13 | PASS |
| readings over 15 s | 1,470 | 1,470 | PASS |
| refreshes failed or timed out | 556 | 556 | PASS |
| breaching readings (slow + failed) | 2,026 | 2,026 | PASS |
| alerts needing attention (not resolutions) | 838 | 838 | PASS |
| alerts including resolutions | 1,181 | 1,181 | PASS |
| reports outside 10% on credits | 64 | 64 | PASS |
| readings flagged on AWS cost | 625 | 625 | PASS |
| alerts with a data-supported cause | 721 | 721 | PASS |
| alerts with none (sent to a person) | 117 | 117 | PASS |

## 7. The SQL, checked statically as Snowflake SQL

No Snowflake account was available, so the suite was not run there. These checks parse it in Snowflake's dialect (sqlglot), resolve every table and column against `sql/00_schema.sql`, and match each generated CSV to the table it loads into. They find typos and mismatches; they cannot show the results are right, and the parser is lenient. See `docs/snowflake-run.md`.

| Check | Result | Status |
|---|---|---|
| 00_schema.sql parses as Snowflake SQL | 11 statements | PASS |
| 10_credit_attribution.sql parses as Snowflake SQL | 2 statements | PASS |
| 11_unit_cost.sql parses as Snowflake SQL | 1 statements | PASS |
| 12_reconciliation_checks.sql parses as Snowflake SQL | 1 statements | PASS |
| 13_report_variance.sql parses as Snowflake SQL | 1 statements | PASS |
| 14_views_vs_aws_cost.sql parses as Snowflake SQL | 1 statements | PASS |
| 00_schema.sql defines the tables the suite reads | core.observations_clean, core.quarantine_ledger, core.reports, core.cost_params, sim_account_usage.query_history, sim_account_usage.warehouse_metering_history | PASS |
| 10_credit_attribution.sql: every table and column resolves | all resolve | PASS |
| 11_unit_cost.sql: every table and column resolves | all resolve | PASS |
| 12_reconciliation_checks.sql: every table and column resolves | all resolve | PASS |
| 13_report_variance.sql: every table and column resolves | all resolve | PASS |
| 14_views_vs_aws_cost.sql: every table and column resolves | all resolve | PASS |
| observations_clean.csv lines up with core.observations_clean, column for column in order | 21 columns | PASS |
| quarantine_ledger.csv lines up with core.quarantine_ledger, column for column in order | 5 columns | PASS |
| reports.csv lines up with core.reports, column for column in order | 11 columns | PASS |
| sim_query_history.csv lines up with sim_account_usage.query_history, column for column in order | 7 columns | PASS |
| sim_warehouse_metering_history.csv lines up with sim_account_usage.warehouse_metering_history, column for column in order | 7 columns | PASS |
| the checker rejects a mistyped keyword | SELEC 1 | PASS |
| the checker rejects a misspelt column | report_idd | PASS |
| the checker rejects a table that does not exist | core.no_such_table | PASS |
| the checker accepts a correct query (it does not reject everything) | report_id | PASS |

## Causes found by the rules

Alerts each cause was found on (an alert can have several): HIGH_CONCURRENCY 203, HIGH_QUERY_VOLUME 210, OWNERSHIP_GAP 107, RECURRING_SLOWNESS 567, REPEATED_FAILURES 62.

## What this does and does not show

- It shows the app's numbers can be reproduced from the raw file by a second, separate implementation, to the last digit where the data is exact.
- It was written by the same person as the app, from the same written rules, so it catches slips and drift, **not a wrong reading of the brief**.
- The SQL suite was compared through its SQLite stand-in and checked statically as Snowflake SQL (section 7). It was also run on a Snowflake trial account (see `docs/snowflake-run.md`), on the simulated usage tables rather than real `ACCOUNT_USAGE` views.
- Credit price is a placeholder ($3), so dollar totals are illustrative; the checks cover credits, ratios and rankings.
- The data is synthetic and statistically random, so what is "expensive" or "slow" reflects the generator, not any real report.
