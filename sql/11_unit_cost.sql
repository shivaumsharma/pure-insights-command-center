-- Step 2 of 5: cost per report and cost per active view.
--
--   total_cost_usd   = attributed_credits x credit_price_usd + AWS hosting cost
--   cost_per_view    = total_cost_usd / total active views   (NULL when a report has no views at all)
--
-- Definitions worth knowing:
--   * Pooled ratio: SUM(cost) / SUM(views) across a report's observations, not the average of per-observation
--     ratios. It cannot be wrecked by one observation with a handful of views.
--   * Each observation is treated as one billing period with its own cost and its own views. The source has
--     no overlap information, so views are not de-duplicated across observations (assumption D11).
--   * idle_cost_usd is spend during observations that had zero views. It is real spend with nobody using
--     the report, so it is shown separately and not hidden inside the ratio.
--   * Credits are the ATTRIBUTED credits from step 1, not the CSV's claimed figure.
--   * credit_price_usd is a placeholder in core.cost_params; do not quote dollar totals until it is replaced.
--
-- Orphan columns come from core.reports so the dashboard can show "money spent on reports nobody owns".

SELECT
  c.report_id,
  MAX(c.report_name)                                                              AS report_name,
  r.is_orphaned,
  r.last_known_owner_email,
  COUNT(*)                                                                        AS observations,
  SUM(c.monthly_active_views)                                                     AS total_views,
  ROUND(SUM(c.attributed_credits), 4)                                             AS attributed_credits,
  ROUND(SUM(c.attributed_credits) * p.credit_price_usd, 2)                        AS credit_cost_usd,
  ROUND(SUM(c.aws_hosting_cost_usd), 2)                                           AS aws_cost_usd,
  ROUND(SUM(c.attributed_credits) * p.credit_price_usd + SUM(c.aws_hosting_cost_usd), 2) AS total_cost_usd,
  CASE WHEN SUM(c.monthly_active_views) > 0
       THEN ROUND((SUM(c.attributed_credits) * p.credit_price_usd + SUM(c.aws_hosting_cost_usd))
                  / SUM(c.monthly_active_views), 4)
  END                                                                             AS cost_per_view_usd,
  CASE WHEN SUM(c.monthly_active_views) > 0
       THEN ROUND(SUM(c.attributed_credits) * p.credit_price_usd / SUM(c.monthly_active_views), 4)
  END                                                                             AS credit_cost_per_view_usd,
  SUM(CASE WHEN c.monthly_active_views = 0 THEN 1 ELSE 0 END)                     AS zero_view_observations,
  ROUND(SUM(CASE WHEN c.monthly_active_views = 0
                 THEN c.attributed_credits * p.credit_price_usd + c.aws_hosting_cost_usd
                 ELSE 0 END), 2)                                                  AS idle_cost_usd
FROM core.cost_allocation c
CROSS JOIN core.cost_params p
LEFT JOIN core.reports r ON r.report_id = c.report_id
WHERE c.observation_id IS NOT NULL
GROUP BY c.report_id, r.is_orphaned, r.last_known_owner_email, p.credit_price_usd
ORDER BY total_cost_usd DESC, c.report_id;
