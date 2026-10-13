#!/usr/bin/env python3
"""Independent validation of the Pure Insights Command Center.

Re-derives every headline number from the RAW CSV with its own code (Python standard library only, nothing shared with the JavaScript or
the SQL) and compares it with what the app produces. Run it with `npm run validate`; it writes validation/REPORT.md and exits 1 if any
check fails.

What it covers, in the order the data flows:
  1. cleaning       raw CSV -> clean readings, quarantined rows, orphans            vs data/processed/*.csv and dq_report.json
  2. alerts         every alert the engine raises, one by one                        vs the app's alert engine (run by scripts/dump-app-results.mjs)
  3. cost           credits attributed to each report, cost per view, variance       vs the SQL suite's output (data/processed/cost_*.csv)
  4. AWS mismatch   readings whose hosting cost does not fit their views            vs cost_aws_mismatch.csv
  5. explanations   which causes the data supports for each alert                    vs the app's rule-based explainer
  6. claims         the numbers quoted in README.md
  7. SQL, static    the SQL suite parsed as Snowflake SQL, every table and column resolved against the schema, and each CSV matched to its table
                    (needs `pip install -r validation/requirements.txt`; skipped with a note if sqlglot is absent, required when REQUIRE_SQLGLOT=1)

What it does NOT show: it was written by the same person as the code, from the same written rules (docs/decisions.md), so it catches
slips and drift, not a wrong reading of the brief. The SQL was compared through its SQLite stand-in and checked statically as Snowflake SQL, but
never run on a real Snowflake account.
"""
import csv
import json
import math
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / 'data' / 'raw' / 'Case_Study_3_Pure_Insights_Monitoring.csv'
PROCESSED = ROOT / 'data' / 'processed'
OUT = Path(__file__).resolve().parent / 'REPORT.md'

# ---- the written rules (docs/decisions.md; thresholds also in the brief) -------------------------------------------------
EPOCH_MS = 1_788_220_800_000  # 2026-09-01T00:00:00Z, the synthetic timeline's start (D3)
HOUR_MS, SPACING_MS = 3_600_000, 30_000
LATENCY_LIMIT, LATENCY_CEILING = 15, 55
COOLDOWN_MS, CLEAR_AFTER, FAILURE_CRITICAL = 6 * HOUR_MS, 2, 3
CREDIT_PRICE, TOLERANCE_PCT, AWS_RATIO = 3.0, 10.0, 3.0  # core.cost_params; the credit price is a placeholder
WAREHOUSES = ['PI_ADHOC_WH', 'PI_BATCH_WH', 'PI_EXEC_WH', 'PI_REPORTING_WH']
NUMERIC = [('monthly_active_views', True), ('snowflake_credits_consumed', False), ('avg_load_time_sec', False),
           ('aws_hosting_cost_usd', False), ('query_count_last_30d', True), ('concurrent_user_peak', True)]
NUM_RE = re.compile(r'^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$')
EMAIL_RE = re.compile(r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
MISSING_OWNER = {'', 'nan', 'null', 'none', 'n/a', 'na', 'undefined'}
STATUSES = {'SUCCESS', 'FAILED', 'TIMED_OUT', 'UNKNOWN'}
RANK = {'low': 1, 'medium': 2, 'high': 3, 'critical': 4}

# The numbers README.md quotes. A change to the code or the data that moves one of these fails the run until the README is updated.
CLAIMS = {
    'rows received': 2000, 'rows used': 1976, 'rows set aside (all: negative credits)': 24, 'reports': 100, 'reports with no owner now': 13,
    'readings over 15 s': 1470, 'refreshes failed or timed out': 556, 'breaching readings (slow + failed)': 2026,
    'alerts needing attention (not resolutions)': 838, 'alerts including resolutions': 1181,
    'reports outside 10% on credits': 64, 'readings flagged on AWS cost': 625,
    'alerts with a data-supported cause': 721, 'alerts with none (sent to a person)': 117,
}


# =========================================================== 1. cleaning
def clean_raw():
    with open(RAW, newline='', encoding='utf-8') as f:
        rows = list(csv.reader(f))
    header, body = rows[0], rows[1:]
    at = {h: i for i, h in enumerate(header)}
    occurrence, first_seen, seen = {}, {}, set()
    clean, aside = [], []
    for line, raw in enumerate(body, start=2):  # the header is line 1
        if len(raw) != len(header):
            aside.append((line, None, ['MALFORMED_ROW']))
            continue
        rid = raw[at['report_id']].strip().upper()
        reasons = []
        if rid == '':
            reasons.append('MISSING_REPORT_ID')
        key = '\x01'.join(v.strip() for v in raw)
        if key in seen:
            reasons.append('DUPLICATE_ROW')
        seen.add(key)
        num = {}
        for col, integer in NUMERIC:
            s = raw[at[col]].strip()
            value = float(s) if NUM_RE.match(s) and math.isfinite(float(s)) else None
            if value is None:
                reasons.append('NON_NUMERIC')
            elif integer and value != int(value):
                reasons.append('NON_INTEGER')
            elif value < 0:
                reasons.append('NEGATIVE_CREDITS' if col == 'snowflake_credits_consumed' else 'NEGATIVE_VALUE')
            num[col] = value
        if reasons:
            aside.append((line, rid or None, list(dict.fromkeys(reasons))))
            if rid:  # a set-aside row still occupies its slot on the timeline
                occurrence[rid] = occurrence.get(rid, 0) + 1
                first_seen.setdefault(rid, len(first_seen))
            continue
        k = occurrence.get(rid, 0)
        occurrence[rid] = k + 1
        first_seen.setdefault(rid, len(first_seen))
        owner_raw = raw[at['owner_email']].strip()
        low = owner_raw.lower()
        if low in MISSING_OWNER:
            owner, kind = None, 'MISSING'
        elif low == 'orphaned_report':
            owner, kind = None, 'SENTINEL'
        elif not EMAIL_RE.match(owner_raw):
            owner, kind = None, 'INVALID'
        else:
            owner, kind = low, None
        status = re.sub(r'[\s-]+', '_', raw[at['last_refresh_status']].strip().upper())
        clean.append({
            'observation_id': f'{rid}:{k + 1:03d}', 'report_id': rid, 'owner': owner, 'orphan_kind': kind,
            'status': status if status in STATUSES else 'UNKNOWN',
            'views': int(num['monthly_active_views']), 'credits': num['snowflake_credits_consumed'], 'load': num['avg_load_time_sec'],
            'aws': num['aws_hosting_cost_usd'], 'queries': int(num['query_count_last_30d']), 'peak': int(num['concurrent_user_peak']),
            't': EPOCH_MS + k * HOUR_MS + first_seen[rid] * SPACING_MS,
        })
    return clean, aside, len(body)


def quartile(values, p):
    s = sorted(values)
    k = (len(s) - 1) * p
    lo, hi = math.floor(k), math.ceil(k)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def statistical_outliers():
    """For each numeric column of the RAW file: values beyond 1.5 x IQR of the quartiles, and values over 3 standard deviations from the mean."""
    with open(RAW, newline='', encoding='utf-8') as f:
        rows = list(csv.DictReader(f))
    result = {}
    for col, _ in NUMERIC:
        values = [float(r[col]) for r in rows if NUM_RE.match(r[col].strip())]
        q1, q3 = quartile(values, 0.25), quartile(values, 0.75)
        low, high = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
        mean = sum(values) / len(values)
        sd = math.sqrt(sum((v - mean) ** 2 for v in values) / len(values))
        result[col] = {'iqr': sum(1 for v in values if v < low or v > high), 'z3': sum(1 for v in values if sd and abs(v - mean) / sd > 3),
                       'negatives_flagged': sum(1 for v in values if v < 0 and v < low)}
    return result


# =========================================================== 2. alerts
def latency_severity(sec):
    return 'critical' if sec >= LATENCY_CEILING else 'high' if sec > 35 else 'medium' if sec > 25 else 'low' if sec > LATENCY_LIMIT else None


def run_alerts(clean):
    """Every alert, as (event_id, time, report, type, lifecycle, severity, repeats held back since the last one)."""
    active, streak, out = {}, {}, []

    def emit(life, typ, o, sev, held):
        out.append([len(out) + 1, o['t'], o['report_id'], typ, life, sev, held])

    def evaluate(typ, o, sev):
        key, t = (o['report_id'], typ), o['t']
        s = active.get(key)
        if sev is None:
            if s:
                s['clear'] += 1
                if s['clear'] >= CLEAR_AFTER:
                    emit('RESOLVED', typ, o, s['sev'], s['held'])
                    del active[key]
            return
        if s:
            s['clear'] = 0
        if not s:
            active[key] = {'sev': sev, 'last': t, 'held': 0, 'clear': 0}
            emit('TRIGGERED', typ, o, sev, 0)
        elif RANK[sev] > RANK[s['sev']]:
            emit('ESCALATED', typ, o, sev, s['held'])
            s.update(sev=sev, last=t, held=0)
        elif t - s['last'] >= COOLDOWN_MS:
            emit('REPEATED', typ, o, sev, s['held'])
            s.update(sev=sev, last=t, held=0)
        else:
            s['held'] += 1

    for o in sorted(clean, key=lambda x: x['t']):
        evaluate('LATENCY', o, latency_severity(o['load']))
        if o['status'] in ('FAILED', 'TIMED_OUT'):
            streak[o['report_id']] = streak.get(o['report_id'], 0) + 1
            evaluate('REFRESH_FAILURE', o, 'critical' if streak[o['report_id']] >= FAILURE_CRITICAL else 'high')
        elif o['status'] == 'SUCCESS':
            streak.pop(o['report_id'], None)
            evaluate('REFRESH_FAILURE', o, None)
        # UNKNOWN: it neither failed nor recovered, so nothing changes
    return out


# =========================================================== 3-4. cost
def warehouse_for(report_id):
    h = 0x811C9DC5  # FNV-1a, 32 bit
    for ch in report_id:
        h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF
    return WAREHOUSES[h % len(WAREHOUSES)]


def half_up(x):
    return math.floor(x + 0.5)


def attribute_costs(clean):
    """Split each warehouse-hour's credits across the queries in it by elapsed-time share (the method in sql/10)."""
    window = {}
    for o in clean:
        o['wh'] = warehouse_for(o['report_id'])
        o['hour'] = o['t'] // HOUR_MS
        o['elapsed'] = half_up(o['queries'] * o['load'] * 1000)
        w = window.setdefault((o['wh'], o['hour']), {'credits': 0.0, 'elapsed': 0})
        w['credits'] += o['credits']
        w['elapsed'] += o['elapsed']
    per = {}
    for o in clean:
        w = window[(o['wh'], o['hour'])]
        credits = half_up(w['credits'] * 1e6) / 1e6
        share = o['elapsed'] / w['elapsed'] if w['elapsed'] > 0 else 0
        o['attributed'] = share * credits
        r = per.setdefault(o['report_id'], {'attributed': 0.0, 'reported': 0.0, 'views': 0, 'aws': 0.0, 'idle': 0.0, 'zero': 0, 'n': 0})
        r['attributed'] += o['attributed']
        r['reported'] += o['credits']
        r['views'] += o['views']
        r['aws'] += o['aws']
        r['n'] += 1
        if o['views'] == 0:
            r['zero'] += 1
            r['idle'] += o['attributed'] * CREDIT_PRICE + o['aws']
    for r in per.values():
        r['total'] = r['attributed'] * CREDIT_PRICE + r['aws']
        r['per_view'] = r['total'] / r['views'] if r['views'] > 0 else None
        if r['reported'] > 0:
            r['variance'] = (r['attributed'] - r['reported']) * 100 / r['reported']
            r['within'] = abs(r['variance']) <= TOLERANCE_PCT
        else:
            r['variance'], r['within'] = None, r['attributed'] == 0
    return per


def aws_mismatches(clean):
    with_views = [o for o in clean if o['views'] > 0]
    per_view = sum(o['aws'] for o in with_views) / sum(o['views'] for o in with_views)
    flagged = {}
    for o in clean:
        if o['views'] == 0 and o['aws'] > 0:
            flagged[o['observation_id']] = 'ZERO_VIEWS_WITH_COST'
        elif o['views'] > 0:
            ratio = o['aws'] / (per_view * o['views'])
            if ratio >= AWS_RATIO:
                flagged[o['observation_id']] = 'COST_HIGH_FOR_USAGE'
            elif ratio <= 1 / AWS_RATIO:
                flagged[o['observation_id']] = 'COST_LOW_FOR_USAGE'
    return flagged, per_view


# =========================================================== 5. explanations
def nearest_rank(values, p):
    s = sorted(values)
    return s[max(0, math.ceil(p * len(s)) - 1)]


def explain(clean, alerts):
    """Which causes the data supports for each alert that is not a resolution, using only the readings up to that alert."""
    p75_queries = nearest_rank([o['queries'] for o in clean], 0.75)
    p75_peak = nearest_rank([o['peak'] for o in clean], 0.75)
    by_time = sorted(clean, key=lambda x: x['t'])
    history, position = {}, {}
    for o in by_time:
        history.setdefault(o['report_id'], []).append(o)
    for rid, rows in history.items():
        for i, o in enumerate(rows):
            position[o['observation_id']] = i
    at_time = {(o['report_id'], o['t']): o for o in clean}
    result = {}
    for event_id, t, rid, typ, life, *_ in alerts:
        if life == 'RESOLVED':
            continue
        o = at_time[(rid, t)]
        seen = history[rid][: position[o['observation_id']] + 1]
        newest = seen[-8:][::-1]  # the report's latest eight readings, newest first
        found = []
        if newest[0]['queries'] >= p75_queries:
            found.append('HIGH_QUERY_VOLUME')
        if newest[0]['peak'] >= p75_peak:
            found.append('HIGH_CONCURRENCY')
        if sum(1 for x in newest[:5] if x['load'] > LATENCY_LIMIT) >= 3:
            found.append('RECURRING_SLOWNESS')
        run = 0
        for x in newest:
            if x['status'] == 'UNKNOWN':
                continue
            if x['status'] in ('FAILED', 'TIMED_OUT'):
                run += 1
            else:
                break
        if run >= 2:
            found.append('REPEATED_FAILURES')
        if newest[0]['owner'] is None:
            found.append('OWNERSHIP_GAP')
        result[event_id] = sorted(found)
    return result


# =========================================================== running and reporting
def read_csv(name):
    with open(PROCESSED / name, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def iso(ms):
    s = ms // 1000
    from datetime import datetime, timezone
    return datetime.fromtimestamp(s, timezone.utc).strftime('%Y-%m-%dT%H:%M:%S') + f'.{ms % 1000:03d}Z'


class Results:
    def __init__(self):
        self.sections, self.failed, self.total = [], 0, 0

    def section(self, title, note='', kind='compare'):
        self.sections.append({'title': title, 'note': note, 'rows': [], 'kind': kind})

    def static(self, name, result, ok):
        self.total += 1
        self.failed += 0 if ok else 1
        self.sections[-1]['rows'].append((name, result, None, ok, ''))
        print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'   {result}'))

    def check(self, name, independent, app, ok=None, detail=''):
        ok = (independent == app) if ok is None else ok
        self.total += 1
        self.failed += 0 if ok else 1
        self.sections[-1]['rows'].append((name, independent, app, ok, detail))
        print(('PASS ' if ok else 'FAIL ') + name + ('' if ok else f'   independent={independent}  app={app}  {detail}'))


def close(a, b, tol):
    return a is None and b is None or (a is not None and b is not None and abs(a - b) <= tol)


def main():
    R = Results()
    clean, aside, rows_in = clean_raw()
    alerts = run_alerts(clean)
    costs = attribute_costs(clean)
    mismatches, aws_rate = aws_mismatches(clean)

    try:
        node = subprocess.run(['node', '--disable-warning=ExperimentalWarning', str(ROOT / 'scripts' / 'dump-app-results.mjs')],
                              capture_output=True, text=True, cwd=ROOT, check=True)
        app = json.loads(node.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as err:
        print('Could not run the app side (needs Node 22 and `npm ci`):', err)
        sys.exit(2)

    # ---- 1 cleaning
    dq = json.load(open(PROCESSED / 'dq_report.json', encoding='utf-8'))
    R.section('1. Cleaning the raw CSV', 'Raw file -> clean readings, set-aside rows and owners. The app side is `npm run data:build`.')
    R.check('rows received', rows_in, dq['rows']['in'])
    R.check('rows used', len(clean), dq['rows']['clean'])
    R.check('rows set aside', len(aside), dq['rows']['quarantined'])
    R.check('every row accounted for (used + set aside = received)', len(clean) + len(aside), rows_in)
    reasons = {}
    for _, _, rs in aside:
        for r in rs:
            reasons[r] = reasons.get(r, 0) + 1
    R.check('set-aside reasons', json.dumps(reasons, sort_keys=True), json.dumps(dq['quarantine_by_reason'], sort_keys=True))
    ledger = {int(r['source_row']): r['reason_codes'] for r in read_csv('quarantine_ledger.csv')}
    R.check('the set-aside ledger lists the same rows with the same reasons', {l: '|'.join(rs) for l, _, rs in aside}, ledger)

    app_clean = read_csv('observations_clean.csv')
    mismatched = 0
    for mine, theirs in zip(clean, app_clean):
        same = (mine['observation_id'] == theirs['observation_id'] and mine['owner'] == (theirs['owner_email'] or None)
                and mine['status'] == theirs['last_refresh_status'] and iso(mine['t']) == theirs['observed_at']
                and close(mine['credits'], float(theirs['snowflake_credits_consumed']), 1e-9) and close(mine['load'], float(theirs['avg_load_time_sec']), 1e-9)
                and mine['views'] == int(theirs['monthly_active_views']) and mine['queries'] == int(theirs['query_count_last_30d'])
                and mine['peak'] == int(theirs['concurrent_user_peak']) and close(mine['aws'], float(theirs['aws_hosting_cost_usd']), 1e-9)
                and (mine['orphan_kind'] or '') == theirs['orphan_kind'])
        mismatched += 0 if same else 1
    R.check('every clean reading matches field by field (id, owner, status, time, numbers, orphan kind)', f'{mismatched} differ', '0 differ' if len(clean) == len(app_clean) else f'{len(app_clean)} rows')

    latest = {}
    for o in sorted(clean, key=lambda x: x['t']):
        latest[o['report_id']] = o
    orphaned_now = sum(1 for o in latest.values() if o['owner'] is None)
    R.check('reports', len(latest), dq['reports']['total'])
    R.check('reports with no owner on their latest reading', orphaned_now, dq['reports']['currently_orphaned'])
    R.check('readings with no usable owner', sum(1 for o in clean if o['owner'] is None), dq['flags_on_clean_rows']['orphan_observations'])
    R.check('readings over 15 s', sum(1 for o in clean if o['load'] > LATENCY_LIMIT), dq['latency']['breaches'])
    R.check('readings at the 55 s ceiling', sum(1 for o in clean if o['load'] >= LATENCY_CEILING), dq['latency']['at_ceiling'])

    outliers = statistical_outliers()
    R.check('numeric columns with a value beyond 1.5 x IQR (a statistical outlier)', [c for c, o in outliers.items() if o['iqr']], [])
    R.check('numeric columns with a value more than 3 standard deviations from the mean', [c for c, o in outliers.items() if o['z3']], [])
    R.check('negative credit values a statistical outlier test would flag (a rule catches them, statistics does not)', outliers['snowflake_credits_consumed']['negatives_flagged'], 0)

    # ---- 2 alerts
    R.section('2. Alerts', 'Every alert, compared one by one in order. The app side is the real alert engine run over the processed data.')
    mine = [[a[0], iso(a[1]), a[2], a[3], a[4], a[5], a[6]] for a in alerts]
    R.check('number of alerts (including resolutions)', len(mine), len(app['alerts']))
    different = sum(1 for a, b in zip(mine, app['alerts']) if a != b)
    R.check('every alert matches: id, time, report, kind, stage, severity, repeats held back', f'{different} differ', '0 differ' if len(mine) == len(app['alerts']) else 'lengths differ')
    for life in ('TRIGGERED', 'ESCALATED', 'REPEATED', 'RESOLVED'):
        R.check(f'alerts at stage {life}', sum(1 for a in alerts if a[4] == life), sum(1 for a in app['alerts'] if a[4] == life))
    breaches = sum(1 for o in clean if o['load'] > LATENCY_LIMIT) + sum(1 for o in clean if o['status'] in ('FAILED', 'TIMED_OUT'))
    attention = sum(1 for a in alerts if a[4] != 'RESOLVED')

    # ---- 3 cost
    sql = {r['report_id']: r for r in read_csv('cost_per_report.csv')}
    R.section('3. Cloud cost attribution', 'Credits split across queries by elapsed-time share, then cost per view. The app side is the SQL suite (sql/10-14) run on its SQLite stand-in.')
    R.check('reports costed', len(costs), len(sql))
    bad = []
    for rid, c in costs.items():
        s = sql.get(rid)
        if s is None:
            bad.append(rid)
            continue
        ok = (close(c['attributed'], float(s['attributed_credits']), 1e-3) and close(c['total'], float(s['total_cost_usd']), 0.01)
              and close(c['idle'], float(s['idle_cost_usd']), 0.01) and c['views'] == int(s['total_views']) and c['n'] == int(s['observations'])
              and close(c['per_view'], float(s['cost_per_view_usd']) if s['cost_per_view_usd'] != '' else None, 1e-3))
        if not ok:
            bad.append(rid)
    R.check('every report: attributed credits, total cost, cost per view, idle spend, views, readings', f'{len(bad)} differ', '0 differ', detail=','.join(bad[:5]))
    ranked = sorted(costs, key=lambda r: (-round(costs[r]['total'], 2), r))
    R.check('the five most expensive reports, in order', ranked[:5], [r['report_id'] for r in list(csv.DictReader(open(PROCESSED / 'cost_per_report.csv', encoding='utf-8')))[:5]])
    # credits are conserved: what was split equals what was metered
    R.check('credits are conserved (attributed total = metered total)', round(sum(c['attributed'] for c in costs.values()), 4), round(sum(o['credits'] for o in clean), 4))
    variance = {r['report_id']: r['status'] for r in read_csv('cost_report_variance.csv')}
    mine_status = {rid: ('WITHIN_TOLERANCE' if c['within'] else 'OUTSIDE_TOLERANCE') for rid, c in costs.items()}
    R.check('reports whose claimed credits are outside 10% of what their queries imply', sum(1 for v in mine_status.values() if v == 'OUTSIDE_TOLERANCE'), sum(1 for v in variance.values() if v == 'OUTSIDE_TOLERANCE'))
    R.check('the same reports are flagged', sorted(r for r, v in mine_status.items() if v == 'OUTSIDE_TOLERANCE'), sorted(r for r, v in variance.items() if v == 'OUTSIDE_TOLERANCE'))

    # ---- 4 AWS
    app_aws = {r['observation_id']: r['mismatch_type'] for r in read_csv('cost_aws_mismatch.csv')}
    R.section('4. Hosting cost that does not fit usage', 'Readings whose AWS cost is far from what their views predict (3x either way, or cost with no views).')
    R.check('readings flagged', len(mismatches), len(app_aws))
    R.check('the same readings, with the same reason', mismatches, app_aws)
    chart = app['awsUsage']
    R.check('the chart\'s fleet hosting cost per view (the average line)', round(aws_rate, 9), round(chart['rate'], 9))
    mine_points = {o['observation_id']: [o['views'], o['aws'], mismatches.get(o['observation_id'])] for o in clean}
    app_points = {r[0]: [r[1], r[2], r[3]] for r in chart['readings']}
    R.check('the chart\'s points: every reading\'s views, hosting cost and flag', f'{sum(1 for k, v in mine_points.items() if app_points.get(k) != v)} differ', '0 differ' if len(mine_points) == len(app_points) else f'{len(app_points)} points')

    # ---- 5 explanations
    mine_causes = explain(clean, alerts)
    R.section('5. Rule-based explanations', 'For each alert that is not a resolution: which causes the data supports, using only readings up to that alert.')
    R.check('alerts explained', len(mine_causes), len(app['explanations']))
    differ = [e for e, k in mine_causes.items() if app['explanations'].get(str(e)) != k]
    R.check('the set of causes matches for every alert', f'{len(differ)} differ', '0 differ', detail=','.join(map(str, differ[:5])))
    with_cause = sum(1 for k in mine_causes.values() if k)
    counts = {}
    for k in mine_causes.values():
        for c in k:
            counts[c] = counts.get(c, 0) + 1

    # ---- 6 claims
    derived = {
        'rows received': rows_in, 'rows used': len(clean), 'rows set aside (all: negative credits)': reasons.get('NEGATIVE_CREDITS', 0) if len(aside) == reasons.get('NEGATIVE_CREDITS', 0) else -1,
        'reports': len(latest), 'reports with no owner now': orphaned_now, 'readings over 15 s': sum(1 for o in clean if o['load'] > LATENCY_LIMIT),
        'refreshes failed or timed out': sum(1 for o in clean if o['status'] in ('FAILED', 'TIMED_OUT')), 'breaching readings (slow + failed)': breaches,
        'alerts needing attention (not resolutions)': attention, 'alerts including resolutions': len(alerts),
        'reports outside 10% on credits': sum(1 for v in mine_status.values() if v == 'OUTSIDE_TOLERANCE'), 'readings flagged on AWS cost': len(mismatches),
        'alerts with a data-supported cause': with_cause, 'alerts with none (sent to a person)': len(mine_causes) - with_cause,
    }
    R.section('6. The numbers quoted in the README', 'Each figure the README states, recomputed here. If one moves, update the README.')
    for name, quoted in CLAIMS.items():
        R.check(name, derived[name], quoted)

    # ---- 7 the SQL, statically
    R.section('7. The SQL, checked statically as Snowflake SQL',
              'No Snowflake account was available, so the suite was not run there. These checks parse it in Snowflake\'s dialect (sqlglot), resolve every table and '
              'column against `sql/00_schema.sql`, and match each generated CSV to the table it loads into. They find typos and mismatches; they cannot show the results '
              'are right, and the parser is lenient. See `docs/snowflake-run.md`.', kind='static')
    try:
        import sql_static
    except ImportError:
        if os.environ.get('REQUIRE_SQLGLOT') == '1':
            R.static('sqlglot is installed (required here)', 'run: pip install -r validation/requirements.txt', False)
        else:
            R.sections[-1]['rows'].append(('not run: sqlglot is not installed', 'pip install -r validation/requirements.txt', None, True, ''))
            print('SKIP the static SQL checks (pip install -r validation/requirements.txt)')
    else:
        for name, result, ok in sql_static.run(ROOT / 'sql', PROCESSED):
            R.static(name, result, ok)

    write_report(R, counts)
    print(f'\n{R.total - R.failed} of {R.total} checks passed. Report written to {OUT.relative_to(ROOT)}')
    sys.exit(1 if R.failed else 0)


def write_report(R, counts):
    lines = ['# Independent validation report', '',
             'Produced by `npm run validate` (`validation/validate.py`). Every figure below was re-derived from the raw CSV by code that shares nothing',
             'with the app, then compared with what the app produced. A `FAIL` means the two disagree and one of them is wrong.', '',
             f'**{R.total - R.failed} of {R.total} checks passed.**', '']
    for s in R.sections:
        if s.get('kind') == 'static':
            lines += [f'## {s["title"]}', '', s['note'], '', '| Check | Result | Status |', '|---|---|---|']
            for name, result, _, ok, _ in s['rows']:
                lines.append(f'| {name} | {result} | {"PASS" if ok else "**FAIL**"} |')
            lines.append('')
            continue
        lines += [f'## {s["title"]}', '', s['note'], '', '| Check | Independent (Python) | App | Result |', '|---|---|---|---|']
        for name, independent, app, ok, detail in s['rows']:
            show = lambda v: ('`' + json.dumps(v)[:60] + '`') if isinstance(v, (dict, list)) else f'{v:,}' if isinstance(v, int) and not isinstance(v, bool) else str(v)
            lines.append(f'| {name} | {show(independent)} | {show(app)} | {"PASS" if ok else "**FAIL**"} |')
        lines.append('')
    lines += ['## Causes found by the rules', '', 'Alerts each cause was found on (an alert can have several): ' + ', '.join(f'{k} {v}' for k, v in sorted(counts.items())) + '.', '',
              '## What this does and does not show', '',
              '- It shows the app\'s numbers can be reproduced from the raw file by a second, separate implementation, to the last digit where the data is exact.',
              '- It was written by the same person as the app, from the same written rules, so it catches slips and drift, **not a wrong reading of the brief**.',
              '- The SQL suite was compared through its SQLite stand-in and checked statically as Snowflake SQL (section 7). **It has never been run on a real Snowflake account.**',
              '- Credit price is a placeholder ($3), so dollar totals are illustrative; the checks cover credits, ratios and rankings.',
              '- The data is synthetic and statistically random, so what is "expensive" or "slow" reflects the generator, not any real report.', '']
    OUT.write_text('\n'.join(lines), encoding='utf-8', newline='\n')


if __name__ == '__main__':
    main()
