# Cost allocation suite (Phase 2)

Answers: **how many Snowflake credits did each report really use, what does a view cost, and can we trust the numbers?**

```bash
npm run data:build   # Phase 1: clean + simulate (writes data/processed/)
npm run cost:build   # Phase 2: runs sql/10-14 locally, writes data/processed/cost_*.csv
npm test
```

## Scripts

Run in order. All are standard SQL kept to the portable subset, and run unchanged on Snowflake after `USE DATABASE PURE_INSIGHTS;`
and on the local SQLite warehouse. Parameters live in `core.cost_params`.

| Script | Purpose | Output |
|---|---|---|
| `10_credit_attribution.sql` | Splits each warehouse-hour's credits across the queries in it by elapsed-time share | table `core.cost_allocation` (one row per report per hour) |
| `11_unit_cost.sql` | Cost per report and per view; idle spend; orphan status | `cost_per_report.csv` |
| `12_reconciliation_checks.sql` | Eight PASS / FAIL / INFO checks on the numbers | `cost_reconciliation_checks.csv` |
| `13_report_variance.sql` | Per-report attributed vs CSV-claimed credits | `cost_report_variance.csv` |
| `14_views_vs_aws_cost.sql` | Observations whose AWS cost does not fit their views | `cost_aws_mismatch.csv` |

## What the checks mean

| Check | Question | Result on this data |
|---|---|---|
| R1 | Do attributed credits equal metered credits in every warehouse-hour? | PASS |
| R2 | Any metered credits in hours where no queries ran? | PASS (0) |
| R3-R5 | Did any join silently drop an observation or a query row? | PASS (0 each) |
| R6 | Any negative credits left after cleaning? | PASS (0) |
| R7 | Attributed total vs CSV total | INFO. Equal, but **true by construction**; it proves nothing |
| R8 | Do per-report attributed credits match what the CSV claims, within 10%? | **FAIL: 64 of 100 reports outside tolerance** |

## How to read the results honestly

- The R8 failure is expected and is the point of the page: the data was generated so each report's CSV credits are independent of its
  query workload (decision D5). It demonstrates that the reconciliation can catch a disagreement; it is not evidence that any real
  report is mis-billed.
- Source columns are statistically unrelated (D6), so rankings such as "most expensive report" or "highest cost per view" reflect the
  generator. Present them as the tool working, not as business conclusions.
- Dollar figures use a **placeholder** credit price. Rankings and ratios are meaningful; absolute dollars are not until the price is set.
- The AWS mismatch detector flags 32% of observations on this data (D13). Treat it as a ranking by excess spend, not a verdict.

## Verification done

- Every figure in `backend/test/cost-real.test.js` was recomputed by a separate Python script that shares no code with the SQL.
- Hand-worked fixtures in `backend/test/cost-sql.test.js` cover attribution, unit cost, zero views, price changes, orphan columns,
  each reconciliation failure mode, and the AWS mismatch classes.
- Mutation checks on a scratch copy: breaking the share formula, price handling, R1 tolerance, variance sign, the query filter and
  both AWS thresholds each made tests fail. One mutation (removing the divide-by-zero guard) is **not** detectable locally; see D9.
