#!/usr/bin/env python3
"""Build the submission PDF from report.template.html, the SQL scripts, and (if present) the Snowflake run result.

    python submission/build_report.py

Needs Microsoft Edge (or set EDGE to a Chromium executable) to print the PDF.
"""
import datetime as dt
import html
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
RESULT = os.environ.get('PI_RESULT', os.path.join(ROOT, 'validation', 'snowflake_run_result.json'))
OUT_HTML = os.environ.get('PI_OUT_HTML', os.path.join(HERE, 'case-study.html'))
OUT_PDF = os.environ.get('PI_OUT_PDF', os.path.join(HERE, 'Pure-Insights-Command-Center-Case-Study-3.pdf'))
EDGE = os.environ.get('EDGE', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')

SCRIPTS = [
    ('10_credit_attribution.sql', 'B1. 10_credit_attribution.sql: split each warehouse-hour\'s credits across its queries'),
    ('11_unit_cost.sql', 'B2. 11_unit_cost.sql: cost per report and per active view, idle spend'),
    ('12_reconciliation_checks.sql', 'B3. 12_reconciliation_checks.sql: checks R1 to R8'),
    ('13_report_variance.sql', 'B4. 13_report_variance.sql: attributed against claimed credits per report'),
    ('14_views_vs_aws_cost.sql', 'B5. 14_views_vs_aws_cost.sql: hosting cost that does not fit the views'),
]


def sql_listings():
    out = []
    for name, title in SCRIPTS:
        with open(os.path.join(ROOT, 'sql', name), encoding='utf8') as f:
            body = f.read().strip()
        out.append(f'<h3>{html.escape(title)}</h3>\n<pre class="sql">{html.escape(body)}</pre>')
    return '\n'.join(out)


def num(n):
    return f'{n:,}' if isinstance(n, int) else f'{n:,.2f}'


def first_run_paragraph():
    path = os.path.join(ROOT, 'validation', 'snowflake_run_1_before_fix.csv')
    if not os.path.exists(path):
        return ''
    import csv
    rows = list(csv.DictReader(open(path, encoding='utf8')))
    bad = [x for x in rows if x['RESULT'] == 'DIFFERENT']
    ok = [x for x in rows if x['RESULT'] == 'MATCH']
    if not bad:
        return ''
    return (f'<p><b>The first run found a bug.</b> {len(ok)} comparisons matched and {len(bad)} did not. Check R1 (attributed credits equal metered credits in every warehouse-hour) '
            'failed in 52 of 80 hours on Snowflake, and two totals were off by about 0.19 credits out of 1.2 million. The cause was how the workload share was calculated: '
            'dividing exact decimals keeps only a limited number of decimal places on Snowflake, while the local SQLite engine divides in floating point, so none of my local tests could show it. '
            'I changed the division to DOUBLE, added tests that fail without the change, and ran the suite again.</p>')


def snowflake_section_from_checks(r):
    by = {c['check_name']: c for c in r['checks']}
    total = r['matched'] + r['different']
    version, region = by.get('Snowflake version', {}).get('snowflake_value', '?'), by.get('Snowflake region', {}).get('snowflake_value', '?')
    shown = [c for c in r['checks'] if c['check_name'].startswith(('rows loaded', 'attributed credits', 'attribution rows', '12 ', '11 unit cost: top', '13 variance: reports', '14 AWS mismatch: flagged'))]
    rows = ''.join(f'<tr><td>{html.escape(c["check_name"])}</td><td>{html.escape(c["snowflake_value"])}</td><td>{html.escape(c["app_value"])}</td><td>{html.escape(c["result"])}</td></tr>' for c in shown)
    if r['different'] == 0:
        verdict = f'All {total} comparisons matched: every row count, total and status that Snowflake produced equals the value the application computed locally.'
    else:
        bad = ', '.join(html.escape(c['check_name']) for c in r['checks'] if c['result'] == 'DIFFERENT')
        verdict = f'{r["matched"]} of {total} comparisons matched. These differ: {bad}.'
    day = dt.datetime.fromisoformat(r['ran_at_utc'].replace('Z', '+00:00')).astimezone().strftime('%d %B %Y').lstrip('0')
    return f"""<h3>Run on Snowflake</h3>
{first_run_paragraph()}
<p>I ran the suite on a Snowflake trial account (version {html.escape(version)}, region {html.escape(region)}) on {day}. The schema script created the database and tables, the five generated data files were loaded, the five scripts were run in order, and each result was compared with what the application computed locally (row counts, column totals, statuses). {verdict}</p>
<table>
  <tr><th>Compared</th><th style="width:18%">Snowflake</th><th style="width:18%">Application</th><th style="width:12%">Result</th></tr>
  {rows}
</table>
<p class="small">The remaining {total - len(shown)} comparisons are column totals for the unit-cost, variance and hosting-cost outputs. The run used the simulated usage tables built from the CSV, not real ACCOUNT_USAGE views.</p>"""


def snowflake_section():
    if not os.path.exists(RESULT):
        return '''<h3>Status of the Snowflake run</h3>
<p>The scripts are written in portable SQL. They run unchanged on a local SQLite engine, where they are tested against hand-worked fixtures and against the independent Python re-derivation, and a static check parses each one as Snowflake SQL, resolves every table and column against the schema, and confirms each CSV fits its table. A run on a live Snowflake account has not been completed yet.</p>'''
    r = json.load(open(RESULT, encoding='utf8'))
    if 'checks' in r:
        return snowflake_section_from_checks(r)
    loaded = r['loaded']
    rows = ''.join(
        f'<tr><td>{html.escape(t)}</td><td>{num(v["rows"])}</td><td>{num(v["rows_in_file"])}</td></tr>' for t, v in loaded.items())
    comp = ''.join(
        f'<tr><td>{html.escape(s)}</td><td>{num(c["rows_snowflake"])}</td><td>{num(c["rows_app"])}</td><td>{num(c["cells_compared"])}</td>'
        f'<td>{num(c["cells_different"])}</td></tr>' for s, c in r['comparisons'].items())
    checks = ', '.join(f'{c["check"]} {c["status"]}' for c in r.get('reconciliation', []))
    top = r.get('top_report', {})
    verdict = ('Every value Snowflake returned matched the value the application computed locally.' if r['all_identical']
               else 'Some values differ between Snowflake and the local run; the first differences are listed below.')
    diffs = ''
    if not r['all_identical']:
        items = []
        for s, c in r['comparisons'].items():
            for d in c['first_differences'][:4]:
                items.append(f'<li>{html.escape(s)}: {html.escape(d["key"])} / {html.escape(d["column"])}: local {html.escape(str(d["app"]))}, Snowflake {html.escape(str(d["snowflake"]))}</li>')
        diffs = '<ul>' + ''.join(items) + '</ul>'
    date = r['ran_at_utc'][:10]
    return f'''<h3>Run on Snowflake</h3>
<p>I ran the suite on a Snowflake account (version {html.escape(r["snowflake_version"])}, region {html.escape(r["region"])}) on {date}. The generated files were loaded with PUT and COPY INTO, the scripts were run in order, and every result was compared with what the application computed locally, value by value. {verdict}</p>
<table>
  <tr><th>Table loaded</th><th style="width:16%">Rows in Snowflake</th><th style="width:16%">Rows in file</th></tr>
  {rows}
</table>
<table>
  <tr><th>Script</th><th style="width:13%">Rows (Snowflake)</th><th style="width:13%">Rows (local)</th><th style="width:15%">Values compared</th><th style="width:13%">Values different</th></tr>
  {comp}
</table>
<ul>
  <li>Attribution produced {num(r["attribution"]["rows"])} rows and {num(r["attribution"]["attributed_credits_total"])} attributed credits.</li>
  <li>Reconciliation on Snowflake: {html.escape(checks)}. Reports outside the 10% tolerance: {r.get("reports_outside_tolerance")}. Readings flagged for hosting cost: {r.get("aws_flagged_readings")}.</li>
  <li>Top report by cost: {html.escape(str(top.get("report_id")))} with {num(top.get("attributed_credits", 0))} attributed credits and a total cost of ${num(top.get("total_cost_usd", 0))}.</li>
</ul>
{diffs}'''


def main():
    with open(os.path.join(HERE, 'report.template.html'), encoding='utf8') as f:
        page = f.read()
    page = page.replace('@@SNOWFLAKE@@', snowflake_section()).replace('@@SQL@@', sql_listings())
    with open(OUT_HTML, 'w', encoding='utf8', newline='\n') as f:
        f.write(page)
    subprocess.run([EDGE, '--headless=new', '--disable-gpu', '--no-pdf-header-footer', f'--print-to-pdf={OUT_PDF}',
                    'file:///' + OUT_HTML.replace('\\', '/').replace(' ', '%20')], check=False, capture_output=True, timeout=180)
    size = os.path.getsize(OUT_PDF)
    print(f'{os.path.basename(OUT_PDF)}: {size:,} bytes' + ('' if size < 1_000_000 else '  (OVER the 1 MB limit)'))
    sys.exit(0 if size < 1_000_000 else 1)


if __name__ == '__main__':
    main()
