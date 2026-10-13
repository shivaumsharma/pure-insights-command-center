import { arcPath, ringAngles, shares } from '../../lib/chartMath.js';
import { Legend } from './StackBars.jsx';

// A ring showing how a whole splits into parts. The summary in `ariaLabel` carries the numbers for assistive technology; the legend repeats
// them for everyone else (and is hidden from assistive technology so they are not read twice).
// segments: [{ key, label, value, tone }]
export function Donut({ segments, ariaLabel, centerValue, centerLabel, formatValue = (v) => String(v), size = 168 }) {
  const values = segments.map((s) => s.value);
  const angles = ringAngles(values);
  const pct = shares(values);
  const total = values.reduce((a, b) => a + (Number.isFinite(b) && b > 0 ? b : 0), 0);
  const c = size / 2;
  const outer = c - 3;
  const inner = outer * 0.64;
  return (
    <figure className="donut">
      <svg className="donut-svg" width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={ariaLabel}>
        <circle className="donut-track" cx={c} cy={c} r={(outer + inner) / 2} strokeWidth={outer - inner} fill="none" />
        {segments.map((s, i) => (angles[i].empty ? null : (
          <path key={s.key} className={`donut-seg ink-${s.tone}`} fill="currentColor" d={arcPath(c, c, outer, inner, angles[i].start, angles[i].end)}>
            <title>{`${s.label}: ${formatValue(s.value)} (${pct[i]}%)`}</title>
          </path>
        )))}
        <text className="donut-value" x={c} y={centerLabel ? c + 2 : c + 8} textAnchor="middle">{total === 0 ? '—' : centerValue}</text>
        {centerLabel && <text className="donut-label" x={c} y={c + 20} textAnchor="middle">{total === 0 ? 'No data' : centerLabel}</text>}
      </svg>
      <figcaption>
        <div aria-hidden="true">
          <Legend
            className="legend-stack"
            items={segments.map((s, i) => ({ key: s.key, tone: s.tone, label: s.label, value: `${formatValue(s.value)} · ${pct[i]}%` }))}
          />
        </div>
      </figcaption>
    </figure>
  );
}
