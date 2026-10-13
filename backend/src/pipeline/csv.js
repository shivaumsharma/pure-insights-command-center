// Minimal RFC 4180 CSV reader/writer. No dependencies on purpose.

export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  let line = 1;
  let startLine = 1;

  const endField = () => {
    record.push(field);
    field = '';
  };
  const endRecord = () => {
    endField();
    const blank = record.length === 1 && record[0] === '';
    if (!blank) records.push({ line: startLine, fields: record });
    record = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"' && field === '') {
      inQuotes = true;
    } else if (c === ',') {
      endField();
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRecord();
      line++;
      startLine = line;
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new Error('CSV ends inside a quoted field');
  if (field !== '' || record.length > 0) endRecord();

  if (records.length === 0) throw new Error('CSV is empty');
  const [head, ...rows] = records;
  return { header: head.fields.map((h) => h.trim()), rows };
}

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => escapeCell(row[c])).join(','));
  return lines.join('\n') + '\n';
}
