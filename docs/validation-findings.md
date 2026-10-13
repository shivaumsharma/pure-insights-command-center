# Validation findings

What was found in the supplied data and in the numbers derived from it, in the form the job asks for: each discrepancy **documented clearly**,
with **evidence anyone can reproduce**, its **impact**, **who it should be routed to**, and the **next step**. Nothing here was changed in the
source data; every exception is either kept and flagged or set aside in a ledger with its reason.

Routing is a suggestion. The brief does not name teams, so the owners below are the roles that would normally own each kind of problem.
Figures come from [`validation/REPORT.md`](../validation/REPORT.md), which re-derives them independently from the raw file (`npm run validate`).

| # | Finding | Evidence (how to reproduce) | Impact | Route to | Next step |
|---|---|---|---|---|---|
| F1 | **24 rows have negative Snowflake credits** (all of them are the only defect in their row) | `GET /api/quarantine` or `data/processed/quarantine_ledger.csv`; `validation/REPORT.md` section 1 | Counting them would understate usage. Setting them aside nets the total up by 161.04 credits, so they look like refunds or adjustments | Snowflake usage / FinOps owner | Confirm whether they are legitimate credit adjustments (then model them as such) or a defect in the feed |
| F2 | **242 readings have no usable owner** (125 empty or `NaN`, 117 the literal `ORPHANED_REPORT`); **13 reports have no owner on their latest reading** and 94 reports have at least one such reading | `GET /api/orphans`; `data/processed/dq_report.md` | Nobody is accountable for those reports, yet they carry about 13% of attributed spend (at the placeholder credit price) | Platform admin / report owners | Assign owners (the Orphaned reports page does this with an audit trail) and stop the feed writing the placeholder |
| F3 | **Every report shows more than one owner across its 20 readings** (100 of 100) | `dq_report.md`, "With more than one distinct owner" | "Current owner" is ambiguous. This project defines it as the owner on the latest reading and keeps the last known one as a suggestion | Platform admin | Decide the source of truth for ownership; today the CSV cannot answer it |
| F4 | **74.4% of readings are over the 15 s limit** (1,470 of 1,976), and 6 are pinned at exactly 55 s | `dq_report.md`, "Latency"; `GET /api/health` | A fixed 15 s rule fires on almost everything, so alerts are de-duplicated (2,026 breaching readings become 838 alerts). The 55 s ceiling looks like a timeout or cap | Platform engineering | Confirm the threshold is right for how load time is measured, and whether 55 s is a timeout (then it is a failure, not a slow load) |
| F5 | **556 refreshes failed or timed out (28.1%); 98 readings have status `UNKNOWN`** | `GET /api/health`; `dq_report.md` | `UNKNOWN` is neither a failure nor a recovery, so it raises no alert and changes no state | BI operations | Find out why status is unknown (feed gap or unmapped value) |
| F6 | **91 readings have more peak concurrent users than monthly active views** | `dq_report.md`, "Peak concurrent users > monthly views" | The two measures cannot both be right, or they cover different windows. Kept, with a warning | Analytics / tracking owner | Document what each column measures and its window |
| F7 | **4 readings have zero views but still cost money** | `dq_report.md`; the idle-spend ranking on the Costs page | Real spend with nobody using the report. Unit cost per view is undefined for them, so it is shown as idle spend | Report owners / FinOps | Review whether those reports should be retired |
| F8 | **625 readings (32%) have hosting cost 3x or more away from what their views predict** | `data/processed/cost_aws_mismatch.csv`; `GET /api/costs/aws-mismatch` | A prompt to investigate, not a verdict: hosting also scales with concurrency and data volume. The 3x line is my choice | Cloud platform / FinOps | Agree a tolerance that fits how hosting is really billed |
| F9 | **64 of 100 reports claim credits more than 10% away from what their query workload implies** | `GET /api/costs/variance`; `validation/REPORT.md` section 3 | In this data the two are unrelated by construction, so this shows the reconciliation can catch a disagreement. **It is not evidence that any real report is mis-billed** | FinOps | Rerun on real `ACCOUNT_USAGE` data; this check is the one that would matter there |
| F10 | **The CSV has no timestamps** | The 10 columns in the file | Order and time-based alerts rest on a synthetic timeline (the k-th row of a report is its k-th hourly reading; decision D3) | Data engineering | Provide a reading time per row |
| F11 | **The columns are statistically unrelated** (correlation about zero between views, credits, cost and latency) | Decision D6 | Rankings such as "most expensive" or "slowest" reflect how the data was generated, not any real behaviour | n/a (a property of the synthetic data) | Do not draw business conclusions from rankings on this data |
| F12 | **The simulated Snowflake logs are derived from the CSV** | Decision D5; `backend/src/pipeline/simulate.js` | Warehouse credit totals equal the CSV totals by construction, which proves nothing on its own. The SQL has never run on a real Snowflake account | Whoever runs the SQL next | Run `docs/snowflake-run.md` on a real account and compare |

## What I did not do

- I did not change, drop or "correct" any source value. F1 rows are set aside and listed; everything else is kept and flagged.
- I did not decide which findings are real defects and which are properties of synthetic data. F9 to F11 in particular only make sense as a test of the checks.
- Several thresholds in the rules (15 s from the brief; 10%, 3x, the severity tiers and the cooldown are mine) are choices. They are listed in the
  [decision log](decisions.md) so a reviewer can disagree with them.
