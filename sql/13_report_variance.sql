-- Step 4 of 5: per-report detail behind check R8. Attributed credits vs the credits the CSV claims.
--
-- variance_pct = (attributed - reported) / reported x 100, so a positive number means the dashboard's
-- source figure UNDER-states what the query logs imply, and a negative number means it over-states.
-- Reported = 0 with attributed > 0 has no meaningful percentage, so variance_pct is NULL and the status
-- is OUTSIDE_TOLERANCE.
--
-- Worst offenders first.

SELECT
  v.report_id,
  ROUND(v.reported, 2)   AS reported_credits,
  ROUND(v.attributed, 2) AS attributed_credits,
  ROUND(v.attributed - v.reported, 2) AS difference,
  CASE WHEN v.reported > 0 THEN ROUND((v.attributed - v.reported) * 100.0 / v.reported, 2) END AS variance_pct,
  CASE
    WHEN v.reported > 0 AND ABS(v.attributed - v.reported) * 100.0 / v.reported <= p.variance_tolerance_pct THEN 'WITHIN_TOLERANCE'
    WHEN v.reported = 0 AND v.attributed = 0 THEN 'WITHIN_TOLERANCE'
    ELSE 'OUTSIDE_TOLERANCE'
  END AS status
FROM (
  SELECT report_id, SUM(attributed_credits) AS attributed, SUM(reported_credits) AS reported
  FROM core.cost_allocation
  WHERE observation_id IS NOT NULL
  GROUP BY report_id
) v
CROSS JOIN core.cost_params p
ORDER BY ABS(v.attributed - v.reported) DESC, v.report_id;
