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


def main():
    drop = '--drop' in sys.argv
    started = dt.datetime.now(dt.timezone.utc)
    conn = connect()
    cur = conn.cursor()
    log = {'steps': [], 'query_ids': {}}

    def run(sql, label=None):
        cur.execute(sql)
        if label:
            log['query_ids'][label] = cur.sfqid
        return cur

    log['snowflake_version'] = run('SELECT CURRENT_VERSION()').fetchone()[0]
    log['region'] = run('SELECT CURRENT_REGION()').fetchone()[0]
    if not run('SELECT CURRENT_WAREHOUSE()').fetchone()[0]:
        rows = run('SHOW WAREHOUSES').fetchall()
        if not rows:
            sys.exit('This account has no warehouse to run queries on. Create one (or set SNOWFLAKE_WAREHOUSE) and try again.')
        run(f'USE WAREHOUSE "{rows[0][0]}"')
    print('connected; Snowflake', log['snowflake_version'])

    # 1. objects
    for s in statements(os.path.join(SQL, '00_schema.sql')):
        run(s)
    run('USE DATABASE PURE_INSIGHTS')
    log['steps'].append({'step': 'sql/00_schema.sql', 'ok': True})
    print('created database PURE_INSIGHTS, schemas and tables')

    # 2. load the generated files with PUT and COPY INTO, as the run guide describes
    run("""CREATE OR REPLACE FILE FORMAT PURE_INSIGHTS.CORE.PI_CSV TYPE = CSV SKIP_HEADER = 1 FIELD_OPTIONALLY_ENCLOSED_BY = '"'
           NULL_IF = ('') TIMESTAMP_FORMAT = 'YYYY-MM-DD"T"HH24:MI:SS.FF3"Z"'""")
    run('CREATE OR REPLACE STAGE PURE_INSIGHTS.CORE.PI_STAGE FILE_FORMAT = PURE_INSIGHTS.CORE.PI_CSV')
    loaded = {}
    for fname, table, expect_rows in LOADS:
        path = os.path.join(PROCESSED, fname).replace('\\', '/')
        run(f"PUT 'file://{path}' @PURE_INSIGHTS.CORE.PI_STAGE OVERWRITE = TRUE")
        run(f'COPY INTO PURE_INSIGHTS.{table} FROM @PURE_INSIGHTS.CORE.PI_STAGE/{fname}.gz ON_ERROR = ABORT_STATEMENT')
        n = run(f'SELECT COUNT(*) FROM PURE_INSIGHTS.{table}').fetchone()[0]
        file_rows = len(read_csv(os.path.join(PROCESSED, fname)))
        loaded[table] = {'rows': n, 'rows_in_file': file_rows, 'ok': n == file_rows and (expect_rows is None or n == expect_rows)}
        print(f'  loaded {table}: {n} rows (file has {file_rows})')
    log['loaded'] = loaded

    # 3. the cost suite, in order
    for s in statements(os.path.join(SQL, '10_credit_attribution.sql')):
        run(s, '10_credit_attribution.sql' if s.upper().startswith('CREATE') else None)
    allocated = run('SELECT COUNT(*), ROUND(SUM(attributed_credits), 2) FROM core.cost_allocation WHERE observation_id IS NOT NULL').fetchone()
    log['attribution'] = {'rows': allocated[0], 'attributed_credits_total': float(allocated[1])}
    print(f'  10_credit_attribution: {allocated[0]} rows, {float(allocated[1])} credits attributed')

    comparisons = {}
    for script, key, fname in QUERIES:
        stmts = statements(os.path.join(SQL, script))
        for s in stmts[:-1]:
            run(s)
        cur.execute(stmts[-1])
        log['query_ids'][script] = cur.sfqid
        names = [d[0].lower() for d in cur.description]
        actual = [dict(zip(names, row)) for row in cur.fetchall()]
        expected = read_csv(os.path.join(PROCESSED, fname))
        r = compare(expected, actual, key)
        comparisons[script] = r
        print(f"  {script}: {r['rows_snowflake']} rows (app {r['rows_app']}); {r['cells_compared']} values compared, {r['cells_different']} different -> {'IDENTICAL' if r['identical'] else 'DIFFERENT'}")
        if script.startswith('12'):
            log['reconciliation'] = [{'check': a['check_id'], 'status': a['status'], 'actual': str(a['actual_value'])} for a in actual]
        if script.startswith('13'):
            log['reports_outside_tolerance'] = sum(1 for a in actual if a['status'] == 'OUTSIDE_TOLERANCE')
        if script.startswith('14'):
            log['aws_flagged_readings'] = len(actual)
        if script.startswith('11') and actual:
            top = actual[0]
            log['top_report'] = {k: (float(v) if isinstance(v, (decimal.Decimal, float)) else v) for k, v in top.items() if k in ('report_id', 'attributed_credits', 'total_cost_usd', 'cost_per_view_usd')}
    log['comparisons'] = comparisons
    log['all_identical'] = all(c['identical'] for c in comparisons.values()) and all(v['ok'] for v in loaded.values())
    log['ran_at_utc'] = started.strftime('%Y-%m-%dT%H:%M:%SZ')

    os.makedirs(os.path.dirname(RESULT), exist_ok=True)
    with open(RESULT, 'w', encoding='utf8') as f:
        json.dump(log, f, indent=2, default=str)
    if drop:
        run('DROP DATABASE IF EXISTS PURE_INSIGHTS')
        print('dropped PURE_INSIGHTS')
    conn.close()
    print('\nRESULT:', 'every result matches the app' if log['all_identical'] else 'differences found; see validation/snowflake_run_result.json')
    print('written:', os.path.relpath(RESULT, ROOT))


if __name__ == '__main__':
    selftest() if '--selftest' in sys.argv else main()
