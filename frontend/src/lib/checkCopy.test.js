import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHECK_COPY, describeCheck } from './checkCopy.js';

const sql = fs.readFileSync(path.resolve(import.meta.dirname, '../../../sql/12_reconciliation_checks.sql'), 'utf8');
const idsInSql = [...new Set([...sql.matchAll(/SELECT 'R(\d)' AS check_id|SELECT 'R(\d)'|UNION ALL\s+SELECT 'R(\d)'/g)].map((m) => `R${m[1] ?? m[2] ?? m[3]}`))].sort();

describe('check explanations', () => {
  it('every check the SQL defines has a name and a reason, and nothing is explained that the SQL does not define', () => {
    expect(idsInSql.length).toBeGreaterThanOrEqual(8);
    expect(Object.keys(CHECK_COPY).sort()).toEqual(idsInSql);
  });

  it('each is a short name, then a reason that says why the check exists', () => {
    for (const [id, c] of Object.entries(CHECK_COPY)) {
      expect(c.name.length, `${id} name`).toBeGreaterThan(8);
      expect(c.name.length, `${id} name`).toBeLessThan(60);
      expect(c.why.length, `${id} reason`).toBeGreaterThan(60);
      expect(c.why, `${id} reason`).not.toBe(c.name);
    }
  });

  it('the three join checks say they are about rows lost in a match, and the circular one says it proves nothing', () => {
    for (const id of ['R3', 'R4', 'R5']) expect(CHECK_COPY[id].why).toMatch(/match|reading|query row|cost/i);
    expect(CHECK_COPY.R7.name).toMatch(/circular/i);
    expect(CHECK_COPY.R7.why).toMatch(/proves nothing/i);
    expect(CHECK_COPY.R8.why).toMatch(/real test/i);
  });

  it('a check the page does not know falls back to the SQL\'s own words', () => {
    expect(describeCheck({ check_id: 'R99', description: 'A new check', note: 'what it does' })).toEqual({ name: 'A new check', why: 'what it does' });
    expect(describeCheck({ check_id: 'R1', description: 'x', note: 'y' }).name).toBe('Credits add back up');
  });
});
