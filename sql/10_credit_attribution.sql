-- Step 1 of 5: attribute warehouse credits to reports.
--
-- Method (the standard way to cost queries on a shared warehouse, since Snowflake bills per warehouse-hour,
-- not per query): split each warehouse-hour's credits across the queries that ran in it, in proportion to
-- their share of elapsed time. A report's credits are the sum over the hours it ran.
--
-- Grain of the output: one row per QUERY_HISTORY row (here, one report in one hour).
--   attributed_credits   this report's share of the warehouse-hour credits
--   reported_credits     what the source CSV claims the report consumed (used only for reconciliation)
--
-- Rules:
--   * Failed and timed-out queries still hold the warehouse, so they keep their share.
--   * Credits are conserved: attributed credits in a warehouse-hour sum to that hour's metered credits.
--     A warehouse-hour with credits but no queries attributes nothing (checked in 12_reconciliation_checks.sql).
--   * LEFT JOIN to observations so a query we cannot match to an observation still carries its credits.
--
-- Portable SQL: runs on Snowflake after "USE DATABASE PURE_INSIGHTS;" and on the local SQLite warehouse.
-- Run this script first; scripts 11-14 read the table it builds.

DROP TABLE IF EXISTS core.cost_allocation;

CREATE TABLE core.cost_allocation AS
WITH workload AS (
  SELECT
    q.query_id,
    REPLACE(q.query_tag, 'report:', '') AS report_id,
    q.warehouse_name,
    q.start_time                        AS query_start,
    q.query_count,
    q.total_elapsed_time_ms             AS elapsed_ms,
    m.start_time                        AS window_start,
    m.end_time                          AS window_end,
    m.credits_used                      AS window_credits
  FROM sim_account_usage.query_history q
  JOIN sim_account_usage.warehouse_metering_history m
    ON  m.warehouse_name = q.warehouse_name
    AND q.start_time >= m.start_time
    AND q.start_time <  m.end_time
),
shares AS (
  SELECT
    w.*,
    SUM(w.elapsed_ms) OVER (PARTITION BY w.warehouse_name, w.window_start) AS window_elapsed_ms
  FROM workload w
),
attributed AS (
  SELECT
    s.*,
    -- DOUBLE on purpose: Snowflake keeps only a limited number of decimal places when it divides exact numbers, which left shares slightly
    -- off and made check R1 fail in 52 of 80 warehouse-hours on a first run on Snowflake. Floating point balances to well under 1e-6.
    CASE WHEN s.window_elapsed_ms > 0 THEN CAST(s.elapsed_ms AS DOUBLE) / s.window_elapsed_ms ELSE 0 END AS workload_share
  FROM shares s
)
SELECT
  o.observation_id,
  a.query_id,
  a.report_id,
  o.report_name,
  a.warehouse_name,
  a.window_start,
  a.window_end,
  a.query_count,
  a.elapsed_ms,
  a.window_elapsed_ms,
  a.window_credits,
  a.workload_share,
  a.workload_share * a.window_credits AS attributed_credits,
  o.snowflake_credits_consumed        AS reported_credits,
  o.monthly_active_views,
  o.aws_hosting_cost_usd,
  o.owner_email
FROM attributed a
LEFT JOIN core.observations_clean o
  ON  o.report_id   = a.report_id
  AND o.observed_at = a.query_start;
