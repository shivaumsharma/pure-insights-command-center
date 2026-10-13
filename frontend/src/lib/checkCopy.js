// Plain-language names and reasons for the cost reconciliation checks (R1 to R8, defined in sql/12_reconciliation_checks.sql).
// The first line says what is checked; the second says why the check exists. A check the page does not know falls back to the SQL's own wording.
//
// Grouped by purpose: R1 to R2 guard that credits are split without being created or lost; R3 to R5 guard that no join silently dropped rows;
// R6 repeats the cleaning step; R7 is circular; R8 is the real test of the data.
export const CHECK_COPY = {
  R1: {
    name: 'Credits add back up',
    why: "Each warehouse-hour's credits are split between the reports that ran in it. This checks the pieces add back to what the warehouse used, so nothing is created or lost in the split.",
  },
  R2: {
    name: 'No credits left without a report',
    why: 'Looks for credits used in an hour when no report ran. Those could not be given to any report, so they would quietly drop out of every total.',
  },
  R3: {
    name: 'Every reading got a cost',
    why: 'Readings are matched to their query rows to get a cost. This checks that no reading was dropped by that match.',
  },
  R4: {
    name: 'Every cost belongs to a reading',
    why: 'The reverse of the check above: a cost line with no reading behind it would charge credits to something that does not exist.',
  },
  R5: {
    name: 'Every query fell inside an hourly window',
    why: 'Credits are measured per warehouse-hour. A query row outside every hour would earn no credits, so its cost would be missing.',
  },
  R6: {
    name: 'No negative credits left',
    why: 'Confirms the cleaning step removed the negative credit values, so no refund-like row distorts the totals.',
  },
  R7: {
    name: 'Total matches the CSV (circular)',
    why: 'Compares the attributed total with the CSV total. They match only because the usage logs were built from the CSV, so this proves nothing; shown for transparency.',
  },
  R8: {
    name: "Each report's credits match its workload",
    why: "The real test: does each report's claimed credits agree with what its query workload implies, within 10%? Here many do not. In this synthetic data the two are unrelated by design, so this shows the check works, not that any real report is mis-billed.",
  },
};

export function describeCheck(check) {
  return CHECK_COPY[check.check_id] ?? { name: check.description, why: check.note };
}
