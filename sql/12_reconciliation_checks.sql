-- Step 3 of 5: independent checks on the cost numbers. One row per check: PASS, FAIL or INFO.
--
-- Why this exists: the dashboard shows attributed credits. These checks re-derive and cross-check them
-- from the raw tables so a wrong number is caught here instead of in front of a stakeholder.
--
--   R1  Conservation per warehouse-hour: attributed credits equal metered credits (windows that had queries).
--   R2  Unattributed credits: metered credits in windows with no queries at all. Should be zero.
--   R3  Every clean observation received a cost allocation (no silent drops from the join).
--   R4  Every allocation matched an observation (no orphaned query rows carrying credits).
--   R5  Every query row landed in a metering window (nothing fell outside the hourly buckets).
--   R6  No negative credits survived cleaning.
--   R7  Attributed total vs the CSV's claimed total. INFO only: the warehouse totals were BUILT from the CSV,
--       so agreement here is true by construction and proves nothing.
--   R8  Per-report agreement: attributed vs CSV-claimed credits within tolerance. This is the real test, because
--       query workload is independent of the CSV credits. Expect FAIL on the synthetic data (see detail in 13).

WITH window_diff AS (
  SELECT
    m.warehouse_name,
    m.start_time,
    m.credits_used,
    COALESCE(SUM(c.attributed_credits), 0) AS attributed,
    COUNT(c.query_id)                      AS queries
  FROM sim_account_usage.warehouse_metering_history m
  LEFT JOIN core.cost_allocation c
    ON c.warehouse_name = m.warehouse_name AND c.window_start = m.start_time
  GROUP BY m.warehouse_name, m.start_time, m.credits_used
),
report_var AS (
  SELECT
    report_id,
    SUM(attributed_credits) AS attributed,
    SUM(reported_credits)   AS reported
  FROM core.cost_allocation
  WHERE observation_id IS NOT NULL
  GROUP BY report_id
),
checks AS (
  SELECT 'R1' AS check_id, 'Attributed = metered credits in every warehouse-hour with queries' AS description,
         0 AS expected_value,
         (SELECT COUNT(*) FROM window_diff WHERE queries > 0 AND ABS(credits_used - attributed) > 0.000001) AS actual_value,
         0 AS is_info,
         'count of warehouse-hours that do not balance' AS note
  UNION ALL
  SELECT 'R2', 'Metered credits in warehouse-hours with no queries', 0,
         (SELECT COALESCE(SUM(credits_used), 0) FROM window_diff WHERE queries = 0), 0,
         'credits that could not be attributed to any report'
  UNION ALL
  SELECT 'R3', 'Clean observations without a cost allocation', 0,
         (SELECT COUNT(*) FROM core.observations_clean o
           WHERE o.observation_id NOT IN (SELECT observation_id FROM core.cost_allocation WHERE observation_id IS NOT NULL)), 0,
         'a non-zero value means the observation-to-query join dropped rows'
  UNION ALL
  SELECT 'R4', 'Allocations that matched no observation', 0,
         (SELECT COUNT(*) FROM core.cost_allocation WHERE observation_id IS NULL), 0,
         'these carry credits but are excluded from unit cost'
  UNION ALL
  SELECT 'R5', 'Query rows outside every metering window', 0,
         (SELECT COUNT(*) FROM sim_account_usage.query_history
           WHERE query_id NOT IN (SELECT query_id FROM core.cost_allocation)), 0,
         'their elapsed time earned no credits'
  UNION ALL
  SELECT 'R6', 'Negative credits in the clean store', 0,
         (SELECT COUNT(*) FROM core.observations_clean WHERE snowflake_credits_consumed < 0), 0,
         'negatives should have been quarantined in Phase 1'
  UNION ALL
  SELECT 'R7', 'Attributed total vs CSV-claimed total (true by construction)',
         (SELECT COALESCE(SUM(snowflake_credits_consumed), 0) FROM core.observations_clean),
         (SELECT COALESCE(SUM(attributed_credits), 0) FROM core.cost_allocation), 1,
         'warehouse credits were built from the CSV, so this match is circular'
  UNION ALL
  SELECT 'R8', 'Reports whose attributed credits differ from CSV-claimed by more than the tolerance', 0,
         (SELECT COUNT(*) FROM report_var v CROSS JOIN core.cost_params p
           WHERE CASE WHEN v.reported > 0
                      THEN ABS(v.attributed - v.reported) * 100.0 / v.reported
                      ELSE CASE WHEN v.attributed > 0 THEN 1000000 ELSE 0 END
                 END > p.variance_tolerance_pct), 0,
         'the real reconciliation: query workload is independent of the CSV credits column'
)
SELECT
  check_id,
  description,
  expected_value,
  actual_value,
  actual_value - expected_value AS difference,
  CASE
    WHEN is_info = 1 THEN 'INFO'
    WHEN ABS(actual_value - expected_value) <= 0.000001 THEN 'PASS'
    ELSE 'FAIL'
  END AS status,
  note
FROM checks
ORDER BY check_id;
