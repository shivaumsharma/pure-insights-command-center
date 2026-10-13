import { useId, useState } from 'react';
import { clamp, compact, niceScale, scaleLinear, smoothPath } from '../../lib/chartMath.js';
import { useElementWidth } from './useElementWidth.js';

// Readings oldest to newest, drawn as a smooth line over a soft fill, with an optional limit line. A reading whose refresh failed is a
// diamond and an unknown one a hollow circle, so what went wrong is told by shape as well as colour.
// Hover, touch or the arrow keys show a reading in a dark tooltip; the same numbers are always available as a table (see the page).
// points: [{ key, label, value, kind?: 'ok' | 'bad' | 'unknown', note? }]
const PAD = { l: 42, r: 14, t: 16, b: 30 };
const TIP = { h: 46 };
const tipWidth = (text) => clamp(Math.round(24 + 6.1 * text.length), 120, 280); // the box grows with its longest line

function Marker({ cx, cy, kind, big }) {
  const k = big ? 1.5 : 1;
  if (kind === 'bad') return <polygon className="mk mk-bad" points={`${cx},${cy - 5.5 * k} ${cx + 5.5 * k},${cy} ${cx},${cy + 5.5 * k} ${cx - 5.5 * k},${cy}`} />;
  if (kind === 'unknown') return <circle className="mk mk-unknown" cx={cx} cy={cy} r={3.6 * k} />;
  return <circle className="mk mk-ok" cx={cx} cy={cy} r={3.2 * k} />;
}

export function LineChart({ points, threshold, thresholdLabel, ariaLabel, formatValue = String, height = 200, tone = 'brand', unit = '' }) {
  const [ref, width] = useElementWidth();
  const [active, setActive] = useState(null);
  const gradientId = `fill-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  if (points.length < 2) return <p className="muted small">Not enough readings to draw a chart.</p>;

  const values = points.map((p) => p.value).filter(Number.isFinite);
  const { max, ticks } = niceScale(Math.max(...values, threshold ?? 0) * 1.05);
  const x = scaleLinear([0, points.length - 1], [PAD.l, width - PAD.r]);
  const y = scaleLinear([0, max], [height - PAD.b, PAD.t]);
  const coords = points.map((p, i) => [x(i), y(p.value)]);
  const line = smoothPath(coords);
  const area = line && `${line} L${x(points.length - 1)} ${y(0)} L${x(0)} ${y(0)} Z`;
  const kinds = new Set(points.map((p) => p.kind ?? 'ok'));

  const nearest = (clientX, left) => clamp(Math.round(((clientX - left - PAD.l) / (width - PAD.l - PAD.r)) * (points.length - 1)), 0, points.length - 1);
  const onMove = (e) => setActive(nearest(e.clientX, e.currentTarget.getBoundingClientRect().left));
  const onTouch = (e) => { if (e.touches[0]) setActive(nearest(e.touches[0].clientX, e.currentTarget.getBoundingClientRect().left)); };
  const onKey = (e) => {
    const last = points.length - 1;
    const moves = { ArrowRight: (i) => Math.min(last, (i ?? -1) + 1), ArrowLeft: (i) => Math.max(0, (i ?? last + 1) - 1), Home: () => 0, End: () => last };
    if (e.key === 'Escape') { setActive(null); return; }
    if (moves[e.key]) { e.preventDefault(); setActive(moves[e.key]); }
  };

  const a = active === null ? null : points[active];
  const tipSub = a ? (a.note ? `${a.label} · ${a.note}` : a.label) : '';
  const tipW = tipWidth(tipSub);
  const tipX = a ? clamp(x(active) - tipW / 2, PAD.l - 30, width - PAD.r - tipW + 6) : 0;
  const tipY = a ? (y(a.value) - TIP.h - 12 < 0 ? y(a.value) + 14 : y(a.value) - TIP.h - 12) : 0;

  return (
    <div className="chart-box" ref={ref}>
      <svg
        className={`linechart ink-${tone}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}
        tabIndex={0} onMouseMove={onMove} onMouseLeave={() => setActive(null)} onTouchStart={onTouch} onTouchMove={onTouch}
        onKeyDown={onKey} onFocus={() => setActive((i) => i ?? points.length - 1)} onBlur={() => setActive(null)}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.3" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{compact(t)}{unit}</text>
          </g>
        ))}
        {area && <path className="area" d={area} fill={`url(#${gradientId})`} />}
        {threshold !== undefined && (
          <>
            <line className="threshold" x1={PAD.l} x2={width - PAD.r} y1={y(threshold)} y2={y(threshold)} />
            {thresholdLabel && <text className="threshold-label" x={width - PAD.r} y={y(threshold) - 5} textAnchor="end">{thresholdLabel}</text>}
          </>
        )}
        <path className="line" d={line} />
        {a && <line className="guide" x1={x(active)} x2={x(active)} y1={PAD.t} y2={height - PAD.b} />}
        {points.map((p, i) => (Number.isFinite(p.value) ? <Marker key={p.key} cx={x(i)} cy={y(p.value)} kind={p.kind} big={i === active} /> : null))}
        <text className="axis" x={PAD.l} y={height - 8} textAnchor="start">{points[0].label}</text>
        <text className="axis" x={width - PAD.r} y={height - 8} textAnchor="end">{points.at(-1).label}</text>
        {a && Number.isFinite(a.value) && (
          <g className="tip" transform={`translate(${tipX} ${tipY})`} pointerEvents="none">
            <rect className="tip-box" width={tipW} height={TIP.h} rx="9" />
            <text className="tip-value" x="12" y="19">{formatValue(a.value)}</text>
            <text className="tip-sub" x="12" y="35">{tipSub}</text>
          </g>
        )}
      </svg>
      <span className="sr-only" aria-live="polite">{a && Number.isFinite(a.value) ? `${a.label}: ${formatValue(a.value)}${a.note ? `, ${a.note}` : ''}` : ''}</span>
      {(kinds.has('bad') || kinds.has('unknown')) && (
        <ul className="legend legend-small" aria-hidden="true">
          <li><svg width="14" height="14" viewBox="0 0 14 14"><circle className="mk mk-ok" cx="7" cy="7" r="3.2" /></svg>Refresh worked</li>
          {kinds.has('bad') && <li><svg width="14" height="14" viewBox="0 0 14 14"><polygon className="mk mk-bad" points="7,1.5 12.5,7 7,12.5 1.5,7" /></svg>Refresh failed or timed out</li>}
          {kinds.has('unknown') && <li><svg width="14" height="14" viewBox="0 0 14 14"><circle className="mk mk-unknown" cx="7" cy="7" r="3.6" /></svg>Unknown</li>}
        </ul>
      )}
    </div>
  );
}
