// Pure helpers behind the charts: axis scales, ticks, whole-number shares and ring arcs. No DOM in here, so every number a chart
// draws can be tested on its own.

export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const finite = (n) => Number.isFinite(n);

// A tidy upper bound and evenly spaced ticks for an axis that starts at 0 and has to hold `max`.
export function niceScale(max, wanted = 4) {
  if (!finite(max) || max <= 0) return { max: 1, step: 1, ticks: [0, 1] };
  const rough = max / wanted;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / magnitude;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude;
  const count = Math.ceil(max / step - 1e-9);
  const ticks = Array.from({ length: count + 1 }, (_, i) => Number((i * step).toPrecision(12)));
  return { max: ticks.at(-1), step, ticks };
}

// 1234 -> "1.2k", 1500000 -> "1.5M". Used for axis labels, where space is tight.
export function compact(n) {
  if (!finite(n)) return '—';
  const abs = Math.abs(n);
  const trim = (x) => String(Math.round(x * 10) / 10);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e3) return `${trim(n / 1e3)}k`;
  return trim(n);
}

// Whole-number percentages that always add up to 100 (largest remainder), so a legend never says 33 + 33 + 33.
export function shares(values) {
  const clean = values.map((v) => (finite(v) && v > 0 ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  if (total === 0) return clean.map(() => 0);
  const raw = clean.map((v) => (100 * v) / total);
  const floors = raw.map(Math.floor);
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - floors[i], i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    if (clean[i] > 0) { floors[i] += 1; left -= 1; }
  }
  return floors;
}

// The width of a bar as a percentage of the track. A value that is not zero always shows, however small next to the biggest.
export function barPercent(value, max, minVisible = 2) {
  if (!finite(value) || !finite(max) || value <= 0 || max <= 0) return 0;
  return clamp((100 * value) / max, minVisible, 100);
}

// A linear scale from a domain to a range. A flat domain (all values equal) maps to the middle of the range instead of dividing by zero.
export function scaleLinear([d0, d1], [r0, r1]) {
  if (d0 === d1) return () => (r0 + r1) / 2;
  return (v) => r0 + ((v - d0) * (r1 - r0)) / (d1 - d0);
}

// Angles run clockwise from 12 o'clock, in radians.
export function polar(cx, cy, r, angle) {
  return [cx + r * Math.sin(angle), cy - r * Math.cos(angle)];
}

// One ring segment per value, as start and end angles. Zero and invalid values get no segment.
export function ringAngles(values) {
  const clean = values.map((v) => (finite(v) && v > 0 ? v : 0));
  const total = clean.reduce((a, b) => a + b, 0);
  let angle = 0;
  return clean.map((v) => {
    const start = angle;
    angle += total === 0 ? 0 : (2 * Math.PI * v) / total;
    return { start, end: angle, empty: v === 0 };
  });
}

const f = (n) => Number(n.toFixed(2));

// The outline of a ring segment between two radii. A segment covering the whole circle is drawn as two halves, because an arc cannot
// start and end on the same point.
export function arcPath(cx, cy, outer, inner, start, end) {
  if (end - start >= 2 * Math.PI - 1e-6) {
    const mid = start + Math.PI;
    return `${arcPath(cx, cy, outer, inner, start, mid)} ${arcPath(cx, cy, outer, inner, mid, start + 2 * Math.PI - 1e-6)}`;
  }
  const large = end - start > Math.PI ? 1 : 0;
  const [x0, y0] = polar(cx, cy, outer, start);
  const [x1, y1] = polar(cx, cy, outer, end);
  const [x2, y2] = polar(cx, cy, inner, end);
  const [x3, y3] = polar(cx, cy, inner, start);
  return `M${f(x0)} ${f(y0)} A${outer} ${outer} 0 ${large} 1 ${f(x1)} ${f(y1)} L${f(x2)} ${f(y2)} A${inner} ${inner} 0 ${large} 0 ${f(x3)} ${f(y3)} Z`;
}

// "M x y L x y ..." through the points, skipping any that are not finite so one bad reading cannot break the whole line.
export function linePath(points) {
  let d = '';
  for (const [x, y] of points) {
    if (!finite(x) || !finite(y)) continue;
    d += `${d === '' ? 'M' : 'L'}${f(x)} ${f(y)} `;
  }
  return d.trim();
}

// A smooth line through the points that never overshoots them (monotone cubic interpolation, Fritsch-Carlson). An ordinary smooth curve
// can dip below a reading or rise above one, which would draw a value that was never measured. Points must run left to right.
export function smoothPath(points) {
  const pts = points.filter(([x, y]) => finite(x) && finite(y));
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${f(pts[0][0])} ${f(pts[0][1])}`;
  const n = pts.length;
  const dx = [];
  const slope = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    if (dx[i] <= 0) return linePath(pts); // not strictly left to right: fall back to straight lines rather than divide by zero
    slope.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  const t = new Array(n);
  t[0] = slope[0];
  t[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / slope[i];
    const b = t[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) { const tau = 3 / Math.sqrt(s); t[i] = tau * a * slope[i]; t[i + 1] = tau * b * slope[i]; }
  }
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    d += ` C${f(x0 + dx[i] / 3)} ${f(y0 + (t[i] * dx[i]) / 3)} ${f(x1 - dx[i] / 3)} ${f(y1 - (t[i + 1] * dx[i]) / 3)} ${f(x1)} ${f(y1)}`;
  }
  return d;
}
