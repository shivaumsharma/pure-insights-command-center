-- Step 5 of 5: AWS hosting cost that does not fit the number of active views.
--
-- The brief calls out "discrepancies between active user counts and AWS hosting compute costs".
-- Definition used here (active users are approximated by monthly_active_views):
--
--   fleet_aws_per_view  = total AWS cost / total views, over observations that have views
--   expected_aws_usd    = fleet_aws_per_view x this observation's views
--   cost_ratio          = actual AWS cost / expected AWS cost
--
--   COST_HIGH_FOR_USAGE      ratio >= aws_mismatch_ratio       (paying much more than usage explains)
--   COST_LOW_FOR_USAGE       ratio <= 1 / aws_mismatch_ratio   (heavy usage on a suspiciously cheap host)
--   ZERO_VIEWS_WITH_COST     no views at all but AWS cost > 0  (ratio undefined)
--
-- Only flagged observations are returned, largest overspend first. A flag is a prompt to investigate, not a
-- verdict: AWS compute scales with concurrency and data volume as well as views, and a single observation is noisy.

WITH fleet AS (
  SELECT CAST(SUM(aws_hosting_cost_usd) AS DOUBLE) / SUM(monthly_active_views) AS aws_per_view
  FROM core.observations_clean
  WHERE monthly_active_views > 0
),
scored AS (
  SELECT
    o.observation_id,
    o.report_id,
    o.observed_at,
    o.monthly_active_views,
    o.concurrent_user_peak,
    o.aws_hosting_cost_usd,
    f.aws_per_view                                   AS fleet_aws_per_view,
    f.aws_per_view * o.monthly_active_views          AS expected_aws_usd,
    CASE WHEN o.monthly_active_views > 0
         THEN o.aws_hosting_cost_usd / (f.aws_per_view * o.monthly_active_views)
    END                                              AS cost_ratio
  FROM core.observations_clean o
  CROSS JOIN fleet f
),
classified AS (
  SELECT
    s.*,
    CASE
      WHEN s.monthly_active_views = 0 AND s.aws_hosting_cost_usd > 0 THEN 'ZERO_VIEWS_WITH_COST'
      WHEN s.cost_ratio >= p.aws_mismatch_ratio                      THEN 'COST_HIGH_FOR_USAGE'
      WHEN s.cost_ratio <= 1.0 / p.aws_mismatch_ratio                THEN 'COST_LOW_FOR_USAGE'
    END AS mismatch_type
  FROM scored s
  CROSS JOIN core.cost_params p
)
SELECT
  observation_id,
  report_id,
  observed_at,
  monthly_active_views,
  concurrent_user_peak,
  ROUND(aws_hosting_cost_usd, 2)                      AS aws_cost_usd,
  ROUND(expected_aws_usd, 2)                          AS expected_aws_usd,
  ROUND(aws_hosting_cost_usd - expected_aws_usd, 2)   AS excess_aws_usd,
  ROUND(cost_ratio, 2)                                AS cost_ratio,
  mismatch_type
FROM classified
WHERE mismatch_type IS NOT NULL
ORDER BY excess_aws_usd DESC, observation_id;
