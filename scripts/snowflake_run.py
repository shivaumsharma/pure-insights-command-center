#!/usr/bin/env python3
"""Run the SQL suite on a real Snowflake account and compare every result with what the app computed locally.

    python scripts/snowflake_run.py            # connect, create PURE_INSIGHTS, load the files, run sql/10-14, compare, write the result
    python scripts/snowflake_run.py --drop     # same, then drop the PURE_INSIGHTS database again
    python scripts/snowflake_run.py --selftest # no network: checks the script's own file handling and comparison

Credentials are never read from this repository and never printed. Connect with one of:
  * a named connection in your Snowflake connections file (~/.snowflake/connections.toml), selected with
    SNOWFLAKE_CONNECTION_NAME (default: the file's default connection), or
  * environment variables SNOWFLAKE_ACCOUNT and SNOWFLAKE_USER, plus SNOWFLAKE_PASSWORD, or
    SNOWFLAKE_AUTHENTICATOR=externalbrowser for single sign-on. Optional: SNOWFLAKE_ROLE, SNOWFLAKE_WAREHOUSE,
    SNOWFLAKE_PASSCODE (the current code, if the account requires multi-factor sign-in).

Needs `pip install snowflake-connector-python` and the files in data/processed (run `npm run data:build` and `npm run cost:build` first).
It writes validation/snowflake_run_result.json, which holds no account name or user name.

No connection from this computer? `--bundle FILE` writes one .sql file to upload and run in a Snowsight worksheet; download the last result grid
as CSV and run `--from-csv THAT.csv` to write the same result file.
"""
import csv
import datetime as dt
import decimal
import io
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
SQL = os.path.join(ROOT, 'sql')
PROCESSED = os.path.join(ROOT, 'data', 'processed')
RESULT = os.path.join(ROOT, 'validation', 'snowflake_run_result.json')

LOADS = [  # file in data/processed -> table. Column order in each file matches its table (checked by validation/sql_static.py).
    ('observations_clean.csv', 'CORE.OBSERVATIONS_CLEAN', 1976),
    ('quarantine_ledger.csv', 'CORE.QUARANTINE_LEDGER', 24),
    ('reports.csv', 'CORE.REPORTS', 100),
    ('sim_query_history.csv', 'SIM_ACCOUNT_USAGE.QUERY_HISTORY', 1976),
    ('sim_warehouse_metering_history.csv', 'SIM_ACCOUNT_USAGE.WAREHOUSE_METERING_HISTORY', None),
]
# script -> (key column(s) used to match rows, the file the app wrote for it)
QUERIES = [
    ('11_unit_cost.sql', ('report_id',), 'cost_per_report.csv'),
    ('12_reconciliation_checks.sql', ('check_id',), 'cost_reconciliation_checks.csv'),
    ('13_report_variance.sql', ('report_id',), 'cost_report_variance.csv'),
    ('14_views_vs_aws_cost.sql', ('observation_id',), 'cost_aws_mismatch.csv'),
]


def statements(path):
    from snowflake.connector.util_text import split_statements
    with open(path, encoding='utf8') as f:
        text = f.read()
    return [s.strip().rstrip(';').strip() for s, _ in split_statements(io.StringIO(text), remove_comments=True) if s.strip().rstrip(';').strip()]


def norm(v):
    """One comparable form for a value from either side: numbers as floats, booleans as 1/0, timestamps as text to the second."""
    if v is None:
        return None
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, (int, float, decimal.Decimal)):
        return float(v)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.strftime('%Y-%m-%dT%H:%M:%S')
    s = str(v).strip()
    if s == '':
        return None
    low = s.lower()
    if low in ('true', 'false'):
        return 1.0 if low == 'true' else 0.0
    try:
        return float(s)
    except ValueError:
        pass
    if len(s) >= 19 and s[4] == '-' and s[10] in 'T ':
        return s[:10] + 'T' + s[11:19]
    return s


def same(a, b):
    a, b = norm(a), norm(b)
    if a is None or b is None:
        return a is b
    if isinstance(a, float) and isinstance(b, float):
        return abs(a - b) <= max(0.0101, 1e-7 * abs(a))  # the scripts ROUND to 2 or 4 places; engines may differ in the last digit
    return a == b


def read_csv(path):
    with open(path, encoding='utf8', newline='') as f:
        return list(csv.DictReader(f))


def compare(expected, actual, key):
    """Compare the app's rows (expected) with Snowflake's rows (actual): same rows, same values in every shared column."""
    k = lambda r: tuple(str(norm(r[c])) for c in key)
    exp, act = {k(r): r for r in expected}, {k(r): r for r in actual}
    cols = [c for c in expected[0].keys() if c in actual[0]] if expected and actual else []
    missing_cols = [c for c in (expected[0].keys() if expected else []) if c not in (actual[0] if actual else {})]
    cells, diffs = 0, []
    for key_, e in exp.items():
        a = act.get(key_)
        if a is None:
            continue
        for c in cols:
            cells += 1
            if not same(e[c], a[c]):
                diffs.append({'key': '/'.join(key_), 'column': c, 'app': e[c], 'snowflake': str(a[c])})
    return {
        'rows_app': len(exp), 'rows_snowflake': len(act),
        'rows_only_in_app': len(set(exp) - set(act)), 'rows_only_in_snowflake': len(set(act) - set(exp)),
        'columns_compared': len(cols), 'columns_missing_in_snowflake': missing_cols,
        'cells_compared': cells, 'cells_different': len(diffs), 'first_differences': diffs[:8],
        'identical': not diffs and len(exp) == len(act) and set(exp) == set(act) and not missing_cols,
    }


def selftest():
    n = 0
    for f in sorted(os.listdir(SQL)):
        if f.endswith('.sql'):
            assert statements(os.path.join(SQL, f)), f
            n += 1
    for _, key, f in QUERIES:
        rows = read_csv(os.path.join(PROCESSED, f))
        r = compare(rows, [{k: v for k, v in x.items()} for x in rows], key)
        assert r['identical'] and r['cells_compared'] > 0, (f, r)
    assert same('1.5', 1.5) and same('TRUE', True) and not same('1.5', 1.6) and same(dt.datetime(2026, 9, 1, 0, 0, 30), '2026-09-01T00:00:30.000Z')
    assert not same('RPT_1', 'RPT_2') and same(None, '')
    tweaked = read_csv(os.path.join(PROCESSED, QUERIES[0][2]))
    expected = [dict(r) for r in tweaked]
    tweaked[0]['total_cost_usd'] = '1.00'
    assert not compare(expected, tweaked, ('report_id',))['identical']
    print(f'self-test passed: {n} SQL files split, comparison catches a changed value, every expected file is readable')


def sql_literal(value, sql_type):
    if value is None or value == '':
        return 'NULL'
    t = sql_type.upper()
    if t.startswith('NUMBER'):
        return str(value)
    v = str(value)
    if t.startswith('TIMESTAMP'):
        v = v.replace('T', ' ').rstrip('Z')
    return "'" + v.replace("'", "''") + "'"


def table_types():
    """{ 'CORE.REPORTS': [(column, type), ...] } read from the CREATE TABLE statements of 00_schema.sql."""
    import re
    out = {}
    for stmt in statements(os.path.join(SQL, '00_schema.sql')):
        m = re.match(r'CREATE OR REPLACE TABLE PURE_INSIGHTS\.(\w+\.\w+)\s*\((.*)\)\s*$', stmt, re.S)
        if not m:
            continue
        cols = []
        for line in re.split(r',\s*\n', m.group(2).strip()):
            parts = line.strip().split()
            if len(parts) >= 2 and not parts[0].upper().startswith(('PRIMARY', 'CONSTRAINT')):
                cols.append((parts[0].lower(), parts[1].rstrip(',')))
        out[m.group(1).upper()] = cols
    return out


def build_bundle(path):
    """Write ONE .sql file that does the whole run inside Snowflake: create the objects, load the data with INSERTs, run sql/10-14, and compare
    sums, counts and statuses with what the app computed. It can be pasted or uploaded into a Snowsight worksheet. No connection is needed."""
    types = table_types()
    lines = ['-- Generated by scripts/snowflake_run.py --bundle. Creates PURE_INSIGHTS, loads the data, runs sql/10-14, compares with the app.', '']
    for st in statements(os.path.join(SQL, '00_schema.sql')):
        lines.append(st + ';')
    lines.append('USE DATABASE PURE_INSIGHTS;')
    for fname, table, _ in LOADS:
        cols = types[table]
        rows = read_csv(os.path.join(PROCESSED, fname))
        assert [c for c, _ in cols] == list(rows[0].keys()), table
        for i in range(0, len(rows), 250):
            vals = ',\n'.join('(' + ', '.join(sql_literal(r[c], t) for c, t in cols) + ')' for r in rows[i:i + 250])
            lines.append(f'INSERT INTO PURE_INSIGHTS.{table} VALUES\n{vals};')
    for st in statements(os.path.join(SQL, '10_credit_attribution.sql')):
        lines.append(st + ';')
    for script, _key, _f in QUERIES:
        lines.append(f"CREATE OR REPLACE TABLE core.run_{script.split('_')[0]} AS\n{statements(os.path.join(SQL, script))[-1]};")

    def total(rows, col):
        return sum(float(r[col]) for r in rows if r[col] not in ('', None))
    checks = []  # (name, SQL expression, the app's value)
    for fname, table, _ in LOADS:
        checks.append((f'rows loaded: {table}', f'(SELECT COUNT(*) FROM PURE_INSIGHTS.{table})', str(len(read_csv(os.path.join(PROCESSED, fname))))))
    obs = read_csv(os.path.join(PROCESSED, 'observations_clean.csv'))
    checks.append(('attributed credits in total', '(SELECT ROUND(SUM(attributed_credits), 2) FROM core.cost_allocation WHERE observation_id IS NOT NULL)', f'{total(obs, "snowflake_credits_consumed"):.2f}'))
    checks.append(('attribution rows', '(SELECT COUNT(*) FROM core.cost_allocation)', str(len(obs))))
    unit = read_csv(os.path.join(PROCESSED, 'cost_per_report.csv'))
    checks.append(('11 unit cost: rows', '(SELECT COUNT(*) FROM core.run_11)', str(len(unit))))
    for c in ('total_views', 'attributed_credits', 'credit_cost_usd', 'aws_cost_usd', 'total_cost_usd', 'cost_per_view_usd', 'idle_cost_usd'):
        checks.append((f'11 unit cost: sum of {c}', f'(SELECT ROUND(SUM({c}), 2) FROM core.run_11)', f'{total(unit, c):.2f}'))
    checks.append(('11 unit cost: top report', '(SELECT report_id FROM core.run_11 ORDER BY total_cost_usd DESC, report_id LIMIT 1)', unit[0]['report_id']))
    checks.append(('11 unit cost: top report total cost', '(SELECT MAX(total_cost_usd) FROM core.run_11)', unit[0]['total_cost_usd']))
    for r in read_csv(os.path.join(PROCESSED, 'cost_reconciliation_checks.csv')):
        checks.append((f'12 {r["check_id"]}: status', f"(SELECT status FROM core.run_12 WHERE check_id = '{r['check_id']}')", r['status']))
        checks.append((f'12 {r["check_id"]}: actual value', f"(SELECT actual_value FROM core.run_12 WHERE check_id = '{r['check_id']}')", r['actual_value']))
    var = read_csv(os.path.join(PROCESSED, 'cost_report_variance.csv'))
    checks.append(('13 variance: rows', '(SELECT COUNT(*) FROM core.run_13)', str(len(var))))
    checks.append(('13 variance: reports outside tolerance', "(SELECT COUNT(*) FROM core.run_13 WHERE status = 'OUTSIDE_TOLERANCE')", str(sum(1 for r in var if r['status'] == 'OUTSIDE_TOLERANCE'))))
    for c in ('reported_credits', 'attributed_credits', 'difference'):
        checks.append((f'13 variance: sum of {c}', f'(SELECT ROUND(SUM({c}), 2) FROM core.run_13)', f'{total(var, c):.2f}'))
    aws = read_csv(os.path.join(PROCESSED, 'cost_aws_mismatch.csv'))
    checks.append(('14 AWS mismatch: flagged readings', '(SELECT COUNT(*) FROM core.run_14)', str(len(aws))))
    for t in sorted({r['mismatch_type'] for r in aws}):
        checks.append((f'14 AWS mismatch: {t}', f"(SELECT COUNT(*) FROM core.run_14 WHERE mismatch_type = '{t}')", str(sum(1 for r in aws if r['mismatch_type'] == t))))
    for c in ('aws_cost_usd', 'expected_aws_usd', 'excess_aws_usd'):
        checks.append((f'14 AWS mismatch: sum of {c}', f'(SELECT ROUND(SUM({c}), 2) FROM core.run_14)', f'{total(aws, c):.2f}'))

    parts = []
    for name, expr, exp in checks:
        n, e = name.replace("'", "''"), exp.replace("'", "''")
        parts.append(
            f"SELECT '{n}' AS check_name, sv::VARCHAR AS snowflake_value, '{e}' AS app_value, CASE "
            f"WHEN TRY_TO_DOUBLE(sv::VARCHAR) IS NOT NULL AND TRY_TO_DOUBLE('{e}') IS NOT NULL "
            f"THEN IFF(ABS(TRY_TO_DOUBLE(sv::VARCHAR) - TRY_TO_DOUBLE('{e}')) <= GREATEST(0.05, 0.000001 * ABS(TRY_TO_DOUBLE('{e}'))), 'MATCH', 'DIFFERENT') "
            f"ELSE IFF(sv::VARCHAR = '{e}', 'MATCH', 'DIFFERENT') END AS result FROM (SELECT {expr} AS sv)")
    parts.append("SELECT 'Snowflake version', CURRENT_VERSION(), '-', 'INFO'")
    parts.append("SELECT 'Snowflake region', CURRENT_REGION(), '-', 'INFO'")
    lines.append('CREATE OR REPLACE TABLE core.run_comparison AS\n' + '\nUNION ALL\n'.join(parts) + ';')
    lines.append("SELECT * FROM core.run_comparison ORDER BY IFF(result = 'DIFFERENT', 0, IFF(result = 'INFO', 2, 1)), check_name;")
    with open(path, 'w', encoding='utf8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')
    print(f'wrote {path}: {len(checks)} comparisons, {sum(len(x) for x in lines):,} characters')


def connect():
    import snowflake.connector as sf
    if os.environ.get('SNOWFLAKE_ACCOUNT') and os.environ.get('SNOWFLAKE_USER'):
        kw = {'account': os.environ['SNOWFLAKE_ACCOUNT'], 'user': os.environ['SNOWFLAKE_USER']}
        if os.environ.get('SNOWFLAKE_PASSWORD'):
            kw['password'] = os.environ['SNOWFLAKE_PASSWORD']
        if os.environ.get('SNOWFLAKE_PASSCODE'):  # the 6-digit code, if your account requires multi-factor sign-in
            kw['passcode'] = os.environ['SNOWFLAKE_PASSCODE']
        if os.environ.get('SNOWFLAKE_AUTHENTICATOR'):
            kw['authenticator'] = os.environ['SNOWFLAKE_AUTHENTICATOR']
        for k in ('role', 'warehouse'):
            if os.environ.get('SNOWFLAKE_' + k.upper()):
                kw[k] = os.environ['SNOWFLAKE_' + k.upper()]
        return sf.connect(**kw)
    name = os.environ.get('SNOWFLAKE_CONNECTION_NAME')
    return sf.connect(connection_name=name) if name else sf.connect()


FINAL = "SELECT * FROM core.run_comparison ORDER BY IFF(result = 'DIFFERENT', 0, IFF(result = 'INFO', 2, 1)), check_name"


def write_result(rows):
    """rows: [(check_name, snowflake_value, app_value, result)] from core.run_comparison. Written without any account or user name."""
    checks = [{'check_name': str(r[0]), 'snowflake_value': str(r[1]), 'app_value': str(r[2]), 'result': str(r[3])} for r in rows]
    out = {'ran_at_utc': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'checks': checks,
           'matched': sum(c['result'] == 'MATCH' for c in checks), 'different': sum(c['result'] == 'DIFFERENT' for c in checks)}
    os.makedirs(os.path.dirname(RESULT), exist_ok=True)
    with open(RESULT, 'w', encoding='utf8') as f:
        json.dump(out, f, indent=2)
    print(f"{out['matched']} of {out['matched'] + out['different']} comparisons match; written: {os.path.relpath(RESULT, ROOT)}")
    return out


def from_csv(path):
    """Read the results grid downloaded from a Snowsight worksheet (the output of the bundle's last statement)."""
    rows = read_csv(path)
    key = lambda r, n: next(v for k, v in r.items() if k.strip().lower() == n)
    return write_result([(key(r, 'check_name'), key(r, 'snowflake_value'), key(r, 'app_value'), key(r, 'result')) for r in rows])


def main():
    import tempfile
    bundle = os.path.join(tempfile.gettempdir(), 'pi_snowflake_run.sql')
    build_bundle(bundle)
    conn = connect()
    cur = conn.cursor()
    if not cur.execute('SELECT CURRENT_WAREHOUSE()').fetchone()[0]:
        rows = cur.execute('SHOW WAREHOUSES').fetchall()
        if not rows:
            sys.exit('This account has no warehouse to run queries on. Create one (or set SNOWFLAKE_WAREHOUSE) and try again.')
        cur.execute(f'USE WAREHOUSE "{rows[0][0]}"')
    todo = statements(bundle)
    for i, st in enumerate(todo, 1):
        cur.execute(st)
        print(f'  statement {i} of {len(todo)} ok', end='\r')
    print()
    rows = cur.execute(FINAL).fetchall()
    out = write_result(rows)
    if '--drop' in sys.argv:
        cur.execute('DROP DATABASE IF EXISTS PURE_INSIGHTS')
        print('dropped PURE_INSIGHTS')
    conn.close()
    sys.exit(0 if out['different'] == 0 else 1)


if __name__ == '__main__':
    if '--selftest' in sys.argv:
        selftest()
    elif '--bundle' in sys.argv:
        build_bundle(sys.argv[sys.argv.index('--bundle') + 1])
    elif '--from-csv' in sys.argv:
        from_csv(sys.argv[sys.argv.index('--from-csv') + 1])
    else:
        main()
