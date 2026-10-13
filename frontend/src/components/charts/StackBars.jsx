import { Link } from 'react-router-dom';
import { barPercent } from '../../lib/chartMath.js';

// Tones are named for what they mean, and each maps to a colour that passes 3:1 against the card (see styles/contrast.test.js).
export const TONES = ['success', 'danger', 'warning', 'info', 'brand', 'muted', 'dark'];

export function Legend({ items, className = '' }) {
  return (
    <ul className={`legend ${className}`.trim()}>
      {items.map((i) => (
        <li key={i.key ?? i.label}>
          <span className={`swatch ink-${i.tone}`} aria-hidden="true" />
          {i.label}{i.value !== undefined && <span className="legend-value"> {i.value}</span>}
        </li>
      ))}
    </ul>
  );
}

// Horizontal bars, one row per item, drawn as CSS so the label, the number and the bar all wrap and scale with the page.
// Every value is also written as text next to its bar, and the bars themselves are hidden from assistive technology, so the chart says
// nothing that the words beside it do not.
//
// rows: [{ key, label, to?, hint?, valueText, segments: [{ value, tone }] }]. A row with several segments is stacked; all rows share one scale.
export function StackBars({ rows, label, max, legend }) {
  const totals = rows.map((r) => r.segments.reduce((sum, s) => sum + (Number.isFinite(s.value) && s.value > 0 ? s.value : 0), 0));
  const scale = max ?? Math.max(0, ...totals);
  return (
    <div className="stackbars">
      {legend && <Legend items={legend} />}
      <ul className="bars" aria-label={label}>
        {rows.map((r, i) => (
          <li className="bar-row" key={r.key}>
            <span className="bar-label">
              {r.to ? <Link to={r.to}>{r.label}</Link> : r.label}
              {r.hint && <span className="muted small"> {r.hint}</span>}
            </span>
            <span className="bar-track" aria-hidden="true">
              {r.segments.map((s, j) => {
                const width = barPercent(s.value, scale, totals[i] > 0 ? 1 : 0);
                return width > 0 ? <span key={j} className={`bar-seg ink-${s.tone}`} style={{ width: `${width}%` }} /> : null;
              })}
            </span>
            <span className="bar-value">{r.valueText}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// The common case: one value per row.
export function BarList({ rows, label, max, legend }) {
  return (
    <StackBars
      label={label} max={max} legend={legend}
      rows={rows.map((r) => ({ ...r, segments: [{ value: r.value, tone: r.tone ?? 'brand' }] }))}
    />
  );
}
