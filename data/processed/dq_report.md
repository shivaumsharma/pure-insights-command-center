# Data-quality report

Source: `Case_Study_3_Pure_Insights_Monitoring.csv`

## Row outcome

| Measure | Rows |
|---|---|
| In | 2000 |
| Clean | 1976 |
| Quarantined | 24 |
| Clean + quarantined = in | yes |

## Quarantined (removed from the clean store, kept in the ledger)

| Reason | Rows |
|---|---|
| `NEGATIVE_CREDITS` | 24 |

_A row with several problems is counted once per reason, so reason counts can exceed quarantined rows._

## Flagged but kept (clean rows)

| Flag | Rows | Why it is kept |
|---|---|---|
| Orphan observation (no owner) | 242 | The report still costs money; ownership is a finding, not a reason to drop it |
| - owner empty / NaN | 125 |  |
| - `ORPHANED_REPORT` marker | 117 |  |
| - invalid email | 0 |  |
| Refresh status UNKNOWN | 98 | Unknown is not a failure; excluded from failure alerts |
| Zero monthly views | 4 | Unit cost per view is undefined; handled in the cost SQL |
| - of which still incur cost | 4 | Idle spend |
| Peak concurrent users > monthly views | 91 | Implausible combination; surfaced as a warning |

## Latency

| Measure | Value |
|---|---|
| Rows over 15 s | 1470 (74.39% of clean) |
| Rows at 55 s (looks like a cap) | 6 |
| Maximum | 55 s |

## Reports

| Measure | Reports |
|---|---|
| With clean observations | 100 |
| Currently orphaned (latest observation has no owner) | 13 |
| With at least one orphan observation | 94 |
| With more than one distinct owner | 100 |

## Credits before and after

| Measure | Credits |
|---|---|
| Sum of all parseable source values | 1206191.44 |
| Sum in clean store | 1206352.48 |
| Change caused by quarantine | 161.04 |

_Positive means the quarantined rows were net-negative (refund-like), so the clean total is higher than the source total._

