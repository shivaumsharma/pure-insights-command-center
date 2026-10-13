# Running the SQL suite on a real Snowflake account

**Status: run on 14 October 2026 on a Snowflake trial account (version 10.37.100, AWS Asia Pacific Southeast 7).** All 45 comparisons with the application's numbers match.
The first run found a precision problem (52 of 80 warehouse-hours failed check R1) caused by exact-decimal division on Snowflake. The scripts now divide in DOUBLE, and the
second run matched everywhere. Both result grids are kept: `validation/snowflake_run_1_before_fix.csv` and `validation/snowflake_run_2_after_fix.csv` (decision D47).

The scripts are kept to portable SQL and also run unchanged on a local SQLite stand-in, where they are tested (`backend/test/cost-sql.test.js`, `cost-real.test.js`) and checked
against an independent Python re-derivation (`npm run validate`). What was run on Snowflake is the simulated usage tables built from the CSV, not real `ACCOUNT_USAGE` views.

## The quick way (about 3 minutes)

1. `npm run data:build` and `npm run cost:build`, then `python scripts/snowflake_run.py --bundle snowflake_run.sql --warehouse YOUR_WAREHOUSE`.
2. In Snowsight, Workspaces, **Add new, Upload files**: choose `snowflake_run.sql`. Open it, use the arrow next to Run and choose **Run all**.
3. The last result is a table of comparisons (`MATCH` or `DIFFERENT`). Download it as CSV and run `python scripts/snowflake_run.py --from-csv THAT.csv`.

With the Snowflake Python connector installed and credentials in environment variables, `python scripts/snowflake_run.py` does all of it from a terminal (see the top of that file).
The manual route below is the same thing done by hand.

## 1. Create the objects

1. Open a SQL worksheet with a role that can create a database (the trial's default does).
2. Paste and run `sql/00_schema.sql`. It creates database `PURE_INSIGHTS`, schemas `CORE` and `SIM_ACCOUNT_USAGE`, six tables, and one row of
   parameters (credit price `3.0` is a **placeholder**, tolerance `10`, hosting ratio `3`).
3. Run `USE DATABASE PURE_INSIGHTS;` (the cost scripts refer to `core.` and `sim_account_usage.` tables without the database name).

## 2. Load the generated files

Run `npm run data:build` first if `data/processed/` is empty. Then load each file into its table. In Snowsight: the table's page, then
**Load data**, choose the CSV, use a file format with *skip header* = 1 and this timestamp format, because the files write times as
`2026-09-01T00:00:30.000Z`:

```sql
CREATE OR REPLACE FILE FORMAT PURE_INSIGHTS.CORE.PI_CSV
  TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"' NULL_IF = ('')
  TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"';
```

| File in `data/processed/` | Table |
|---|---|
| `observations_clean.csv` | `CORE.OBSERVATIONS_CLEAN` |
| `quarantine_ledger.csv` | `CORE.QUARANTINE_LEDGER` |
| `reports.csv` | `CORE.REPORTS` |
| `sim_query_history.csv` | `SIM_ACCOUNT_USAGE.QUERY_HISTORY` |
| `sim_warehouse_metering_history.csv` | `SIM_ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY` |

(The command-line route with `PUT` and `COPY INTO` is written out at the bottom of `sql/00_schema.sql`.) Check the row counts:
`OBSERVATIONS_CLEAN` 1,976; `QUARANTINE_LEDGER` 24; `REPORTS` 100; `QUERY_HISTORY` 1,976; `WAREHOUSE_METERING_HISTORY` is hourly per warehouse.

## 3. Run the suite, in order, and compare

| Run | Expect |
|---|---|
| `sql/10_credit_attribution.sql` (builds `CORE.COST_ALLOCATION`) | succeeds; 1,976 rows |
| `SELECT ROUND(SUM(attributed_credits), 2) FROM core.cost_allocation WHERE observation_id IS NOT NULL;` | **1206352.48**, the same as the clean credits total |
| `sql/11_unit_cost.sql` | 100 rows; first row `RPT_299`, `total_cost_usd` **71948.79**, `cost_per_view_usd` **4.7232**, `attributed_credits` **22391.9301** |
| `sql/12_reconciliation_checks.sql` | R1 to R6 `PASS`; R7 `INFO`; **R8 `FAIL` with actual value 64** (this failure is the point; see the cost-suite page) |
| `sql/13_report_variance.sql` | 100 rows; the first is `RPT_299`, `reported_credits` 7795.11, `attributed_credits` 22391.93, `variance_pct` 187.26 |
| `sql/14_views_vs_aws_cost.sql` | **625 rows** (Snowsight shows the row count) |

These are the same values `validation/REPORT.md` lists. Matching them would let me say the suite **reproduces on Snowflake**; a difference is a
finding about Snowflake's SQL dialect (rounding, window frames, timestamp handling) or about my SQL, and is worth writing up either way.

## 4. What to keep as evidence

A screenshot of each result, and the worksheet's **Query History** showing the runs. Add what you found, pass or fail, to
`docs/validation-findings.md`.
