import { compact, niceScale, scaleLinear } from '../../lib/chartMath.js';
import { useElementWidth } from './useElementWidth.js';

// Two measures of the same thing against each other, on one shared scale, with the "they agree" diagonal drawn in. A point on the line
// agrees; the further off it, the bigger the gap. Disagreeing points are diamonds and agreeing ones circles, so it is not colour alone.
// points: [{ key, label, x, y, off }]   (off = true when it disagrees)
const PAD = { l: 52, r: 16, t: 14, b: 42 };

export function Scatter({ points, xTitle, yTitle, diagonalLabel, ariaLabel, formatValue = String }) {
  const [ref, width] = useElementWidth();
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length === 0) return <p className="muted small">Nothing to plot.</p>;

  const height = Math.round(Math.min(360, Math.max(240, width * 0.62)));
  const { max, ticks } = niceScale(Math.max(...usable.flatMap((p) => [p.x, p.y])) * 1.04, 5);
  const x = scaleLinear([0, max], [PAD.l, width - PAD.r]);
  const y = scaleLinear([0, max], [height - PAD.b, PAD.t]);

  return (
    <div className="chart-box" ref={ref}>
      <svg className="scatter" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        {ticks.map((t) => (
          <g key={t}>
            <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
            <line className="grid" x1={x(t)} x2={x(t)} y1={PAD.t} y2={height - PAD.b} />
            <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{compact(t)}</text>
            <text className="axis" x={x(t)} y={height - PAD.b + 16} textAnchor="middle">{compact(t)}</text>
          </g>
        ))}
        <line className="diagonal" x1={x(0)} y1={y(0)} x2={x(max)} y2={y(max)} />
        {diagonalLabel && <text className="threshold-label" x={x(max) - 6} y={y(max) + 14} textAnchor="end">{diagonalLabel}</text>}
        {usable.map((p) => {
          const cx = x(p.x);
          const cy = y(p.y);
          return (
            <g key={p.key}>
              <title>{`${p.label}: ${xTitle} ${formatValue(p.x)}, ${yTitle} ${formatValue(p.y)}`}</title>
              {p.off
                ? <polygon className="pt pt-off" points={`${cx},${cy - 5.5} ${cx + 5.5},${cy} ${cx},${cy + 5.5} ${cx - 5.5},${cy}`} />
                : <circle className="pt pt-on" cx={cx} cy={cy} r={3.8} />}
            </g>
          );
        })}
        <text className="axis-title" x={(PAD.l + width - PAD.r) / 2} y={height - 6} textAnchor="middle">{xTitle}</text>
        <text className="axis-title" transform={`translate(12 ${(PAD.t + height - PAD.b) / 2}) rotate(-90)`} textAnchor="middle">{yTitle}</text>
      </svg>
      <ul className="legend legend-small" aria-hidden="true">
        <li><svg width="14" height="14" viewBox="0 0 14 14"><circle className="pt pt-on" cx="7" cy="7" r="3.8" /></svg>Agrees (within 10%)</li>
        <li><svg width="14" height="14" viewBox="0 0 14 14"><polygon className="pt pt-off" points="7,1.5 12.5,7 7,12.5 1.5,7" /></svg>Disagrees</li>
      </ul>
    </div>
  );
}
