import { compact, niceScale, scaleLinear } from '../../lib/chartMath.js';
import { useElementWidth } from './useElementWidth.js';

// Marks on two axes. Two uses:
//   - two measures of the same thing against each other, on ONE shared scale, with the "they agree" diagonal (sameScale, the default);
//   - two different measures (views and hosting cost), each on its own scale, with straight reference lines through the origin (lines).
// Marks that disagree are diamonds and agreeing ones circles, so it is never colour alone. With many marks they are drawn smaller.
// points: [{ key, label, x, y, off }]   (off = true when it is outside what the reference says is normal)
// lines: [{ slope, label, tone?: 'main' | 'edge' }]   y = slope * x, clipped to the plot
const PAD = { l: 52, r: 16, t: 14, b: 42 };
const MANY = 400;

export function Scatter({
  points, xTitle, yTitle, diagonalLabel, ariaLabel, formatValue = String, sameScale = true, lines = [],
  onLabel = 'Agrees (within 10%)', offLabel = 'Disagrees', formatX = formatValue, formatY = formatValue,
}) {
  const [ref, width] = useElementWidth();
  const usable = points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (usable.length === 0) return <p className="muted small">Nothing to plot.</p>;

  const height = Math.round(Math.min(360, Math.max(240, width * 0.62)));
  const maxX = Math.max(...usable.map((p) => p.x));
  const maxY = Math.max(...usable.map((p) => p.y));
  const shared = Math.max(maxX, maxY);
  const xs = niceScale((sameScale ? shared : maxX) * 1.04, 5);
  const ys = niceScale((sameScale ? shared : maxY) * 1.04, 5);
  const x = scaleLinear([0, xs.max], [PAD.l, width - PAD.r]);
  const y = scaleLinear([0, ys.max], [height - PAD.b, PAD.t]);
  const many = usable.length > MANY;
  const r = many ? 2.6 : 3.8;
  const d = many ? 4 : 5.5;

  // A line y = slope * x runs from the origin until it leaves the plot at the top or on the right.
  const clip = (slope) => {
    const xEnd = slope > 0 ? Math.min(xs.max, ys.max / slope) : xs.max;
    return { x1: x(0), y1: y(0), x2: x(xEnd), y2: y(slope * xEnd) };
  };
  const diagonal = sameScale ? clip(1) : null;

  return (
    <div className="chart-box" ref={ref}>
      <svg className="scatter" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={ariaLabel}>
        {ys.ticks.map((t) => (
          <g key={`y${t}`}>
            <line className="grid" x1={PAD.l} x2={width - PAD.r} y1={y(t)} y2={y(t)} />
            <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{compact(t)}</text>
          </g>
        ))}
        {xs.ticks.map((t) => (
          <g key={`x${t}`}>
            <line className="grid" x1={x(t)} x2={x(t)} y1={PAD.t} y2={height - PAD.b} />
            <text className="axis" x={x(t)} y={height - PAD.b + 16} textAnchor="middle">{compact(t)}</text>
          </g>
        ))}
        {diagonal && <line className="diagonal" {...diagonal} />}
        {diagonal && diagonalLabel && <text className="threshold-label" x={x(xs.max) - 6} y={y(ys.max) + 14} textAnchor="end">{diagonalLabel}</text>}
        {lines.map((l) => {
          const c = clip(l.slope);
          return (
            <g key={l.label}>
              <line className={`refline refline-${l.tone ?? 'edge'}`} {...c} />
              <text className="threshold-label" x={c.x2 - 6} y={c.y2 + (c.y2 > PAD.t + 16 ? -5 : 14)} textAnchor="end">{l.label}</text>
            </g>
          );
        })}
        {usable.map((p) => {
          const cx = x(p.x);
          const cy = y(p.y);
          return (
            <g key={p.key}>
              {!many || p.off ? <title>{`${p.label}: ${xTitle} ${formatX(p.x)}, ${yTitle} ${formatY(p.y)}`}</title> : null}
              {p.off
                ? <polygon className="pt pt-off" points={`${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}`} />
                : <circle className={`pt pt-on${many ? ' pt-faint' : ''}`} cx={cx} cy={cy} r={r} />}
            </g>
          );
        })}
        <text className="axis-title" x={(PAD.l + width - PAD.r) / 2} y={height - 6} textAnchor="middle">{xTitle}</text>
        <text className="axis-title" transform={`translate(12 ${(PAD.t + height - PAD.b) / 2}) rotate(-90)`} textAnchor="middle">{yTitle}</text>
      </svg>
      <ul className="legend legend-small" aria-hidden="true">
        <li><svg width="14" height="14" viewBox="0 0 14 14"><circle className="pt pt-on" cx="7" cy="7" r="3.8" /></svg>{onLabel}</li>
        <li><svg width="14" height="14" viewBox="0 0 14 14"><polygon className="pt pt-off" points="7,1.5 12.5,7 7,12.5 1.5,7" /></svg>{offLabel}</li>
      </ul>
    </div>
  );
}
