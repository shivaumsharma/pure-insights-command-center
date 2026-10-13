# Independent validation

The job this project is for is to **re-run an application's analytics independently, compare them with the source data, and document what
agrees and what does not**. This folder does that to this project.

```bash
npm run validate     # needs Node 22 and Python 3; no packages to install. Writes REPORT.md. Exits 1 if anything disagrees.
```

`validate.py` reads the **raw CSV**, with its own code (Python standard library only, nothing shared with the JavaScript or the SQL), and
re-derives:

| Step | Re-derived from the raw file | Compared with |
|---|---|---|
| Cleaning | clean readings, set-aside rows and reasons, owners (missing, `ORPHANED_REPORT`, invalid), the synthetic timeline | `data/processed/*.csv`, `dq_report.json` (the app's pipeline), field by field |
| Alerts | every alert: when, which report, latency or failure, stage, severity, repeats held back | the real alert engine, run by `scripts/dump-app-results.mjs`, one alert at a time |
| Cost | credits split over each warehouse-hour by elapsed-time share, cost per report and per view, idle spend, variance against the CSV | the SQL suite's output (`data/processed/cost_*.csv`) |
| Hosting cost | readings whose AWS cost is 3x off what their views predict | `cost_aws_mismatch.csv` |
| Explanations | which causes the data supports for each alert, using only readings up to that alert | the app's rule-based explainer |
| README | every number the README quotes | the figures above |

`REPORT.md` is the result, committed so it can be read without running anything.

## How I know the validator can fail

I changed the app, the data and the claims in a throwaway copy and checked that each change makes it fail (and says what differs):
alert cooldown, a severity tier, the number of clear readings before resolving, the critical failure streak, two explanation rules, an owner
blanked in the clean data, an edited cost figure, a wrong variance status, a deleted AWS-mismatch row, a negative-credit row put back, and two
wrong README numbers. All 13 were caught.

## What it does not show

- The author is the same person as the author of the code, working from the same written rules (`docs/decisions.md`). It catches slips and drift
  between two implementations. **It does not catch a wrong reading of the brief.**
- The SQL was compared through its SQLite stand-in. **It has never been run on a real Snowflake account.** A reader who has one can run
  `sql/00_schema.sql` then `sql/10`-`14` and compare `core.cost_allocation` with `data/processed/cost_per_report.csv`.
- The credit price is a placeholder ($3), so the checks cover credits, ratios and rankings rather than dollar totals.
- The data is synthetic and statistically random, so "expensive" and "slow" reflect how it was generated.
