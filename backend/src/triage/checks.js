// "How it was checked": the validator's many findings, grouped into the handful of questions a reader actually cares about.
// Each group is OK (nothing found), UNVERIFIED (could not be checked against the data) or FALSE (the data contradicts it).
// A finding the groups do not know still shows up, under "Other", so nothing the validator found can go missing from the list.

export const CHECK_GROUPS = [
  { id: 'shape', label: 'The answer has the expected shape and length', codes: ['SCHEMA_INVALID', 'NO_EXPLANATION', 'TOO_LONG', 'CONFIDENCE_OUT_OF_RANGE'] },
  { id: 'cites', label: 'Every cited fact exists, and its value is right', codes: ['UNKNOWN_EVIDENCE', 'UNKNOWN_FIELD', 'VALUE_MISMATCH', 'NO_CITATION', 'NO_RELEVANT_CITATION', 'EVIDENCE_MISSING'] },
  { id: 'causes', label: 'Each cause passes its own data test', codes: ['CAUSE_CONTRADICTED', 'OTHER_UNVERIFIABLE'] },
  { id: 'numbers', label: 'Every number in the text is in the evidence', codes: ['UNSUPPORTED_NUMBER'] },
  { id: 'text', label: 'No links, markup or instructions', codes: ['SUSPICIOUS_TEXT'] },
  { id: 'actions', label: 'Each next step is justified by a supported cause', codes: ['ACTION_UNSUPPORTED'] },
  { id: 'confidence', label: 'The confidence matches the evidence', codes: ['OVERCONFIDENT', 'LOW_CONFIDENCE', 'HUMAN_REQUESTED'] },
];

export function checklist(findings = []) {
  const known = new Set(CHECK_GROUPS.flatMap((g) => g.codes));
  const result = CHECK_GROUPS.map((g) => {
    const hits = findings.filter((f) => g.codes.includes(f.code));
    return { id: g.id, label: g.label, result: hits.some((f) => f.severity === 'error') ? 'FALSE' : hits.length > 0 ? 'UNVERIFIED' : 'OK' };
  });
  const other = findings.filter((f) => !known.has(f.code));
  if (other.length > 0) result.push({ id: 'other', label: 'Other checks', result: other.some((f) => f.severity === 'error') ? 'FALSE' : 'UNVERIFIED' });
  return result;
}
