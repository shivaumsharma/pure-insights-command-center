"""Static checks of the SQL suite as SNOWFLAKE SQL, without a Snowflake account.

Uses the open-source `sqlglot` parser (pip install -r validation/requirements.txt). What these checks establish, and what they do not:

  They show that every script parses in Snowflake's dialect, that every table and column the query scripts use exists in the schema defined by
  00_schema.sql (so a misspelt name is caught), and that each generated CSV lines up, column for column and in order, with the table it would be
  loaded into.

  They do NOT run anything. They cannot show that the results are right, that Snowflake accepts every function and type the way sqlglot does, or
  that the numbers match; the parser is also lenient (it accepts some invalid SQL, e.g. an empty PARTITION BY). The only thing that proves the SQL
  works on Snowflake is running it there (docs/snowflake-run.md).
"""
import csv
import sqlglot
from sqlglot import exp
from sqlglot.errors import ErrorLevel
from sqlglot.optimizer.qualify import qualify

DIALECT = 'snowflake'
QUERY_SCRIPTS = ['11_unit_cost.sql', '12_reconciliation_checks.sql', '13_report_variance.sql', '14_views_vs_aws_cost.sql']
# generated file -> the table it is loaded into (docs/snowflake-run.md)
LOADS = {
    'observations_clean.csv': ('core', 'observations_clean'),
    'quarantine_ledger.csv': ('core', 'quarantine_ledger'),
    'reports.csv': ('core', 'reports'),
    'sim_query_history.csv': ('sim_account_usage', 'query_history'),
    'sim_warehouse_metering_history.csv': ('sim_account_usage', 'warehouse_metering_history'),
}


def parse(text):
    return [s for s in sqlglot.parse(text, read=DIALECT, error_level=ErrorLevel.RAISE) if s is not None]


def schema_from(statements):
    """{schema: {table: {column: type}}} from the CREATE TABLE statements."""
    schema = {}
    for st in statements:
        if isinstance(st, exp.Create) and st.args.get('kind') == 'TABLE':
            table = st.this.this
            cols = {c.name.lower(): (c.args['kind'].sql(dialect=DIALECT) if c.args.get('kind') else 'TEXT')
                    for c in st.this.expressions if isinstance(c, exp.ColumnDef)}
            schema.setdefault(table.db.lower(), {})[table.name.lower()] = cols
    return schema


def tables_used(select):
    """(schema, table) for every real table a query reads; names defined by a WITH clause are not tables."""
    ctes = {c.alias.lower() for c in select.find_all(exp.CTE)}
    return {(t.db.lower(), t.name.lower()) for t in select.find_all(exp.Table) if not (t.db == '' and t.name.lower() in ctes)}


def check_query(select, schema):
    """Returns a list of problems (empty when every column resolves and every table exists)."""
    problems = []
    for db, name in sorted(tables_used(select)):
        if name not in schema.get(db, {}):
            problems.append(f'unknown table {db}.{name}')
    try:
        qualify(select.copy(), schema=schema, dialect=DIALECT, validate_qualify_columns=True)
    except Exception as err:  # sqlglot raises OptimizeError with the unresolved column name
        problems.append(str(err).splitlines()[0][:120])
    return problems


def run(sql_dir, processed_dir):
    """Returns [(check name, result text, ok)]."""
    out = []
    texts = {p.name: p.read_text(encoding='utf-8') for p in sorted(sql_dir.glob('*.sql'))}

    parsed = {}
    for name, text in texts.items():
        try:
            parsed[name] = parse(text)
            out.append((f'{name} parses as Snowflake SQL', f'{len(parsed[name])} statements', True))
        except Exception as err:
            out.append((f'{name} parses as Snowflake SQL', str(err).splitlines()[0][:120], False))
    if '00_schema.sql' not in parsed or '10_credit_attribution.sql' not in parsed:
        return out

    schema = schema_from(parsed['00_schema.sql'])
    out.append(('00_schema.sql defines the tables the suite reads', ', '.join(f'{s}.{t}' for s, ts in schema.items() for t in ts), len(schema) == 2))

    # script 10 builds core.cost_allocation from a SELECT; its columns are what scripts 11-14 may use
    build = [s for s in parsed['10_credit_attribution.sql'] if isinstance(s, exp.Create)][0]
    problems = check_query(build.expression, schema)
    out.append(('10_credit_attribution.sql: every table and column resolves', '; '.join(problems) or 'all resolve', not problems))
    if not problems:
        schema.setdefault('core', {})['cost_allocation'] = {c.lower(): 'TEXT' for c in qualify(build.expression.copy(), schema=schema, dialect=DIALECT).named_selects}
    for name in QUERY_SCRIPTS:
        if name not in parsed:
            continue
        problems = [p for st in parsed[name] for p in check_query(st, schema)]
        out.append((f'{name}: every table and column resolves', '; '.join(problems) or 'all resolve', not problems))

    # the generated files must line up with the tables they are loaded into, or COPY INTO loads the wrong columns
    for file, (db, table) in LOADS.items():
        path = processed_dir / file
        if not path.exists():
            out.append((f'{file} lines up with {db}.{table}', 'file missing (run npm run data:build)', False))
            continue
        with open(path, newline='', encoding='utf-8') as f:
            header = next(csv.reader(f))
        wanted = list(schema.get(db, {}).get(table, {}))
        out.append((f'{file} lines up with {db}.{table}, column for column in order', f'{len(header)} columns' if header == wanted else f'file has {header}, table has {wanted}', header == wanted))

    # prove the checks are not vacuous: they must reject known-bad input
    def rejects(fn):
        try:
            fn()
            return False
        except Exception:
            return True

    def has_problems(sql):
        return bool(check_query(sqlglot.parse_one(sql, read=DIALECT), schema))

    out.append(('the checker rejects a mistyped keyword', 'SELEC 1', rejects(lambda: parse('SELEC 1'))))
    out.append(('the checker rejects a misspelt column', 'report_idd', has_problems('SELECT c.report_idd FROM core.cost_allocation c')))
    out.append(('the checker rejects a table that does not exist', 'core.no_such_table', has_problems('SELECT x.a FROM core.no_such_table x')))
    out.append(('the checker accepts a correct query (it does not reject everything)', 'report_id', not has_problems('SELECT c.report_id FROM core.cost_allocation c')))
    return out
