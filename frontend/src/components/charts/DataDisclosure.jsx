import { useState } from 'react';

// "View the numbers as a table" under a chart: the same data in a form a screen reader or a keyboard can walk through.
// The table is only built while it is open, so a page with several charts does not carry several hidden tables.
export function DataDisclosure({ summary = 'View the numbers as a table', children }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="disclosure" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>{summary}</summary>
      {open && <div className="disclosure-body">{children}</div>}
    </details>
  );
}
