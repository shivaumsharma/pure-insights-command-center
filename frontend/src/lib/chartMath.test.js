import { describe, expect, it } from 'vitest';
import { arcPath, barPercent, clamp, compact, linePath, niceScale, polar, ringAngles, scaleLinear, shares, smoothPath } from './chartMath.js';

describe('niceScale', () => {
  it('rounds the top of the axis up to a tidy step and returns evenly spaced ticks from 0', () => {
    expect(niceScale(55)).toEqual({ max: 60, step: 20, ticks: [0, 20, 40, 60] });
    expect(niceScale(35.5)).toEqual({ max: 40, step: 10, ticks: [0, 10, 20, 30, 40] });
    expect(niceScale(0.9)).toEqual({ max: 1, step: 0.5, ticks: [0, 0.5, 1] });
  });
  it('always covers the value it was given', () => {
    for (const v of [0.3, 1, 7, 14.9, 15, 18898, 71948.79, 1e6, 3.2e7]) {
      const { max, ticks } = niceScale(v);
      expect(max).toBeGreaterThanOrEqual(v);
      expect(ticks[0]).toBe(0);
      expect(ticks.at(-1)).toBe(max);
      const steps = ticks.slice(1).map((t, i) => Number((t - ticks[i]).toPrecision(9)));
      expect(new Set(steps).size).toBe(1); // evenly spaced
    }
  });
  it('survives nothing to scale', () => {
    for (const bad of [0, -5, NaN, Infinity, undefined]) expect(niceScale(bad)).toEqual({ max: 1, step: 1, ticks: [0, 1] });
  });
});

describe('compact', () => {
  it('shortens thousands, millions and billions, and keeps small numbers whole', () => {
    expect(compact(0)).toBe('0');
    expect(compact(999)).toBe('999');
    expect(compact(1000)).toBe('1k');
    expect(compact(1234)).toBe('1.2k');
    expect(compact(18898)).toBe('18.9k');
    expect(compact(1_500_000)).toBe('1.5M');
    expect(compact(2_000_000_000)).toBe('2B');
    expect(compact(-1500)).toBe('-1.5k');
    expect(compact(0.25)).toBe('0.3');
    expect(compact(NaN)).toBe('—');
  });
});

describe('shares', () => {
  it('are whole numbers that add up to exactly 100', () => {
    expect(shares([1, 1, 1])).toEqual([34, 33, 33]);
    expect(shares([72, 15, 8, 5])).toEqual([72, 15, 8, 5]);
    for (const values of [[1, 2, 3, 4, 5], [0.1, 0.2, 0.7], [7, 7, 7, 7, 7, 7, 7], [1, 0, 1], [999, 1]]) {
      expect(shares(values).reduce((a, b) => a + b, 0)).toBe(100);
    }
  });
  it('gives a zero value zero percent and survives an empty or invalid set', () => {
    expect(shares([5, 0, 5])).toEqual([50, 0, 50]);
    expect(shares([0, 0])).toEqual([0, 0]);
    expect(shares([])).toEqual([]);
    expect(shares([NaN, -3, 4])).toEqual([0, 0, 100]);
  });
});

describe('barPercent', () => {
  it('scales to the biggest value and clamps to the track', () => {
    expect(barPercent(50, 100)).toBe(50);
    expect(barPercent(100, 100)).toBe(100);
    expect(barPercent(150, 100)).toBe(100);
  });
  it('keeps a small non-zero value visible, and a zero value empty', () => {
    expect(barPercent(1, 100000)).toBe(2);
    expect(barPercent(0, 100)).toBe(0);
    expect(barPercent(-4, 100)).toBe(0);
  });
  it('is 0 when there is nothing to compare against', () => {
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(NaN, 10)).toBe(0);
    expect(barPercent(5, NaN)).toBe(0);
  });
});

describe('scaleLinear', () => {
  it('maps the ends of the domain to the ends of the range, including an upside-down range for y axes', () => {
    const x = scaleLinear([0, 10], [0, 100]);
    expect([x(0), x(5), x(10)]).toEqual([0, 50, 100]);
    const y = scaleLinear([0, 60], [120, 10]);
    expect([y(0), y(60)]).toEqual([120, 10]);
  });
  it('puts a flat domain in the middle instead of dividing by zero', () => {
    expect(scaleLinear([5, 5], [0, 100])(5)).toBe(50);
  });
});

describe('polar, ringAngles and arcPath', () => {
  it('measures angles clockwise from 12 o\'clock', () => {
    const [x, y] = polar(50, 50, 40, 0);
    expect([x, y]).toEqual([50, 10]);
    const [x2, y2] = polar(50, 50, 40, Math.PI / 2);
    expect([Math.round(x2), Math.round(y2)]).toEqual([90, 50]);
  });
  it('splits a full turn in proportion to the values and gives empty segments nothing', () => {
    const a = ringAngles([1, 1, 2]);
    expect(a.map((s) => Number((s.end - s.start).toFixed(4)))).toEqual([Number((Math.PI / 2).toFixed(4)), Number((Math.PI / 2).toFixed(4)), Number(Math.PI.toFixed(4))]);
    expect(a[0].start).toBe(0);
    expect(a.at(-1).end).toBeCloseTo(2 * Math.PI, 10);
    expect(ringAngles([0, 3]).map((s) => s.empty)).toEqual([true, false]);
    expect(ringAngles([0, 0]).every((s) => s.empty && s.start === s.end)).toBe(true);
  });
  it('draws a ring segment, uses the long way round past half a turn, and splits a whole circle in two', () => {
    const quarter = arcPath(80, 80, 70, 50, 0, Math.PI / 2);
    expect(quarter).toMatch(/^M80 10 A70 70 0 0 1 150 80 L130 80 A50 50 0 0 0 80 30 Z$/);
    // three quarters of a turn: the large-arc flag is 1 on the way out and on the way back
    expect(arcPath(80, 80, 70, 50, 0, 1.5 * Math.PI)).toBe('M80 10 A70 70 0 1 1 10 80 L30 80 A50 50 0 1 0 80 30 Z');
    const whole = arcPath(80, 80, 70, 50, 0, 2 * Math.PI);
    expect(whole.match(/M/g)).toHaveLength(2);
    expect(whole).not.toMatch(/NaN/);
  });
});

describe('linePath', () => {
  it('joins points with a move then lines', () => {
    expect(linePath([[0, 10], [5, 20.123], [10, 5]])).toBe('M0 10 L5 20.12 L10 5');
  });
  it('skips points that are not numbers so one bad reading does not break the line', () => {
    expect(linePath([[0, 1], [1, NaN], [2, 3]])).toBe('M0 1 L2 3');
    expect(linePath([[NaN, 1]])).toBe('');
    expect(linePath([])).toBe('');
  });
});

describe('clamp', () => {
  it('limits a value to a range', () => {
    expect([clamp(5, 0, 10), clamp(-1, 0, 10), clamp(11, 0, 10)]).toEqual([5, 0, 10]);
  });
});

describe('smoothPath', () => {
  const nums = (d) => [...d.matchAll(/-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0]));
  // every curve segment as [x0, y0, c1x, c1y, c2x, c2y, x1, y1]
  const segments = (d) => {
    const all = nums(d);
    const out = [];
    for (let i = 2; i + 5 < all.length + 0; i += 6) out.push([all[i - 2], all[i - 1], ...all.slice(i, i + 6)]);
    return out;
  };

  it('starts at the first point, ends at the last, and passes through every point in between', () => {
    const pts = [[0, 10], [10, 40], [20, 5], [30, 25]];
    const d = smoothPath(pts);
    expect(d.startsWith('M0 10 C')).toBe(true);
    expect(d.endsWith('30 25')).toBe(true);
    const all = nums(d);
    for (const [x, y] of pts.slice(1)) {
      const hit = all.some((v, i) => v === x && all[i + 1] === y);
      expect(hit, `${x},${y}`).toBe(true);
    }
  });

  it('never overshoots: between two readings the curve stays between their heights', () => {
    const pts = [[0, 100], [10, 100], [20, 20], [30, 20], [40, 90], [50, 10]];
    for (const [, y0, , c1y, , c2y, , y1] of segments(smoothPath(pts))) {
      const [lo, hi] = [Math.min(y0, y1), Math.max(y0, y1)];
      expect(c1y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(c1y).toBeLessThanOrEqual(hi + 1e-9);
      expect(c2y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(c2y).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it('never overshoots at a sharp bend either: a gentle slope followed by a steep one must not dip below the start', () => {
    // slopes 1 then 10: the plain averaged tangent would swing the curve under its first reading
    for (const [, y0, , c1y, , c2y, , y1] of segments(smoothPath([[0, 0], [10, 10], [20, 110]]))) {
      const [lo, hi] = [Math.min(y0, y1), Math.max(y0, y1)];
      expect(c1y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(c1y).toBeLessThanOrEqual(hi + 1e-9);
      expect(c2y).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(c2y).toBeLessThanOrEqual(hi + 1e-9);
    }
  });

  it('keeps a flat stretch flat', () => {
    const [seg] = segments(smoothPath([[0, 50], [10, 50], [20, 80]]));
    expect(seg[3]).toBe(50);
    expect(seg[5]).toBe(50);
  });

  it('copes with one point, none, a bad point, and points that do not run left to right', () => {
    expect(smoothPath([])).toBe('');
    expect(smoothPath([[5, 6]])).toBe('M5 6');
    expect(smoothPath([[0, 1], [1, NaN], [2, 3]])).toBe(smoothPath([[0, 1], [2, 3]]));
    expect(smoothPath([[0, 1], [0, 5], [3, 3]])).toBe('M0 1 L0 5 L3 3');
    expect(smoothPath([[0, 1], [4, 2]])).not.toMatch(/NaN/);
  });
});
