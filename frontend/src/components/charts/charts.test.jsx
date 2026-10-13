// The chart components, one at a time: what each draws from the numbers it is given, and what it says in words.
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Icon } from '../Icon.jsx';
import { Kpi } from '../ui.jsx';
import { DataDisclosure } from './DataDisclosure.jsx';
import { Donut } from './Donut.jsx';
import { FleetMap } from './FleetMap.jsx';
import { LineChart } from './LineChart.jsx';
import { Segmented } from './Segmented.jsx';
import { Scatter } from './Scatter.jsx';
import { BarList, StackBars } from './StackBars.jsx';

const r = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);
const widths = (container) => [...container.querySelectorAll('.bar-seg')].map((s) => Number.parseFloat(s.style.width));

describe('StackBars and BarList', () => {
  const rows = [
    { key: 'a', label: 'RPT_1', to: '/reports/RPT_1', valueText: '$100', segments: [{ value: 75, tone: 'brand' }, { value: 25, tone: 'warning' }] },
    { key: 'b', label: 'RPT_2', valueText: '$50', segments: [{ value: 50, tone: 'brand' }] },
    { key: 'c', label: 'RPT_3', valueText: '$0', segments: [{ value: 0, tone: 'brand' }] },
  ];

  it('says every value in words next to its bar, links rows that have a destination, and hides the bars themselves from assistive technology', () => {
    const { container } = r(<StackBars label="Spend" rows={rows} />);
    const list = screen.getByRole('list', { name: 'Spend' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'RPT_1' })).toHaveAttribute('href', '/reports/RPT_1');
    expect(screen.queryByRole('link', { name: 'RPT_2' })).toBeNull();
    expect(screen.getByText('$100')).toBeInTheDocument();
    expect([...container.querySelectorAll('.bar-track')].every((t) => t.getAttribute('aria-hidden') === 'true')).toBe(true);
  });

  it('draws every row on one shared scale, stacks segments, and draws nothing for a zero', () => {
    const { container } = r(<StackBars label="Spend" rows={rows} />);
    expect(widths(container)).toEqual([75, 25, 50]); // row 1 is 100 wide in total, row 2 half of it, row 3 nothing
    expect(container.querySelectorAll('.bar-row')[2].querySelectorAll('.bar-seg')).toHaveLength(0);
    expect(container.querySelectorAll('.bar-row')[0].querySelectorAll('.bar-seg.ink-brand, .bar-seg.ink-warning')).toHaveLength(2);
  });

  it('can be put on a scale chosen by the caller, so a part is drawn against the whole', () => {
    const { container } = r(<StackBars label="Rows" max={200} rows={[{ key: 'x', label: 'Rows', valueText: '100', segments: [{ value: 100, tone: 'success' }] }]} />);
    expect(widths(container)).toEqual([50]);
  });

  it('keeps a small but real value visible', () => {
    const { container } = r(<StackBars label="Spend" rows={[
      { key: 'big', label: 'big', valueText: '1', segments: [{ value: 100000, tone: 'brand' }] },
      { key: 'tiny', label: 'tiny', valueText: '1', segments: [{ value: 1, tone: 'brand' }] },
    ]} />);
    expect(widths(container)[1]).toBeGreaterThan(0);
  });

  it('shows a legend when asked, with values', () => {
    r(<StackBars label="Spend" rows={rows} legend={[{ key: 'u', tone: 'brand', label: 'Used', value: '75' }]} />);
    expect(screen.getByText('Used').closest('li')).toHaveTextContent('Used 75');
  });

  it('survives having no rows and values that are not numbers', () => {
    const { container } = r(<StackBars label="None" rows={[]} />);
    expect(container.querySelectorAll('.bar-row')).toHaveLength(0);
    const odd = r(<StackBars label="Odd" rows={[{ key: 'n', label: 'n', valueText: '—', segments: [{ value: NaN, tone: 'brand' }, { value: undefined, tone: 'info' }] }]} />);
    expect(odd.container.querySelectorAll('.bar-seg')).toHaveLength(0);
  });

  it('BarList is the one-value-per-row case, in the tone given (brand by default)', () => {
    const { container } = r(<BarList label="Rank" rows={[{ key: 'a', label: 'a', value: 10, valueText: '10', tone: 'warning' }, { key: 'b', label: 'b', value: 5, valueText: '5' }]} />);
    const segs = container.querySelectorAll('.bar-seg');
    expect(segs[0]).toHaveClass('ink-warning');
    expect(segs[1]).toHaveClass('ink-brand');
    expect(widths(container)).toEqual([100, 50]);
  });
});

describe('Donut', () => {
  const segments = [
    { key: 'ok', label: 'Healthy', value: 72, tone: 'success' },
    { key: 'bad', label: 'Failed', value: 15, tone: 'danger' },
    { key: 'slow', label: 'Timed out', value: 8, tone: 'warning' },
    { key: 'unk', label: 'Unknown', value: 5, tone: 'muted' },
  ];

  it('carries its numbers in an accessible summary, and repeats them in a legend that adds up to 100%', () => {
    const { container } = render(<Donut segments={segments} ariaLabel="Healthy 72, failed 15, timed out 8, unknown 5" centerValue="100" centerLabel="reports" />);
    expect(screen.getByRole('img', { name: 'Healthy 72, failed 15, timed out 8, unknown 5' })).toBeInTheDocument();
    const legend = container.querySelector('.legend');
    expect(legend.closest('[aria-hidden="true"]')).not.toBeNull(); // not read twice
    const percents = [...legend.querySelectorAll('li')].map((li) => Number(li.textContent.match(/(\d+)%/)[1]));
    expect(percents).toEqual([72, 15, 8, 5]);
    expect(percents.reduce((a, b) => a + b, 0)).toBe(100);
    expect(container.querySelectorAll('.donut-seg')).toHaveLength(4);
    expect(screen.getByText('100')).toBeInTheDocument();
  });

  it('puts a hover title on each segment', () => {
    const { container } = render(<Donut segments={segments} ariaLabel="x" centerValue="100" />);
    expect(container.querySelector('.donut-seg title')).toHaveTextContent('Healthy: 72 (72%)');
  });

  it('with nothing to show draws an empty ring and says so, instead of NaN', () => {
    const { container } = render(<Donut segments={segments.map((s) => ({ ...s, value: 0 }))} ariaLabel="x" centerValue="0" centerLabel="reports" />);
    expect(container.querySelectorAll('.donut-seg')).toHaveLength(0);
    expect(screen.getByText('No data')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/NaN/);
  });

  it('a single part fills the whole ring without a broken path', () => {
    const { container } = render(<Donut segments={[{ key: 'all', label: 'All', value: 7, tone: 'success' }, { key: 'none', label: 'None', value: 0, tone: 'danger' }]} ariaLabel="x" centerValue="7" />);
    const paths = container.querySelectorAll('.donut-seg');
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute('d')).not.toMatch(/NaN/);
    expect(paths[0].getAttribute('d').match(/M/g)).toHaveLength(2); // drawn as two halves
  });
});

describe('LineChart', () => {
  const points = [
    { key: '1', label: 'Sep 1, 00:00', value: 10 },
    { key: '2', label: 'Sep 1, 01:00', value: 40, kind: 'bad', note: 'refresh failed' },
    { key: '3', label: 'Sep 1, 02:00', value: 20, kind: 'unknown' },
    { key: '4', label: 'Sep 1, 03:00', value: 12 },
  ];

  it('draws the line, a marker per reading, the limit, and says what it shows', () => {
    const { container } = render(<LineChart points={points} threshold={15} thresholdLabel="15 s limit" ariaLabel="Load time over 4 readings" unit=" s" />);
    expect(screen.getByRole('img', { name: 'Load time over 4 readings' })).toBeInTheDocument();
    expect(container.querySelector('path.line').getAttribute('d')).toMatch(/^M[\d. ]+C/); // a smooth curve, not straight segments
    expect(container.querySelector('path.area').getAttribute('fill')).toMatch(/^url\(#fill-/); // a soft gradient under it
    expect(container.querySelectorAll('.mk-ok')).toHaveLength(2 + 1); // two readings, plus the one in the legend
    expect(screen.getByText('15 s limit')).toBeInTheDocument();
    expect(container.querySelector('line.threshold')).not.toBeNull();
    expect(screen.getByText('Sep 1, 00:00')).toBeInTheDocument();
    expect(screen.getByText('Sep 1, 03:00')).toBeInTheDocument();
  });

  it('marks a failed refresh with a diamond and an unknown one with a hollow circle, so it is not colour alone', () => {
    const { container } = render(<LineChart points={points} ariaLabel="x" />);
    expect(container.querySelectorAll('svg.linechart polygon.mk-bad')).toHaveLength(1);
    expect(container.querySelectorAll('svg.linechart circle.mk-unknown')).toHaveLength(1);
    expect(screen.getByText('Refresh failed or timed out')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  describe('the tooltip', () => {
    const tip = (container) => container.querySelector('g.tip');
    const svgOf = (container) => container.querySelector('svg.linechart');
    // the chart draws at 600 px when there is no layout (tests); readings are spread over the plot area from x = 42 to x = 586
    const xOf = (i, n = 4) => 42 + (i * (600 - 42 - 14)) / (n - 1);

    it('is not there until a reading is pointed at', () => {
      const { container } = render(<LineChart points={points} ariaLabel="x" />);
      expect(tip(container)).toBeNull();
    });

    it('follows the mouse to the nearest reading, shows its value, time and reason, and goes away when the mouse leaves', () => {
      const { container } = render(<LineChart points={points} ariaLabel="x" formatValue={(v) => `${v} s`} />);
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(1) });
      expect(within(tip(container)).getByText('40 s')).toBeInTheDocument();
      expect(within(tip(container)).getByText('Sep 1, 01:00 · refresh failed')).toBeInTheDocument();
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(3) - 5 }); // a little short of the last reading still picks it
      expect(within(tip(container)).getByText('12 s')).toBeInTheDocument();
      fireEvent.mouseLeave(svgOf(container));
      expect(tip(container)).toBeNull();
    });

    it('works with a touch, and never picks a reading beyond either end', () => {
      const { container } = render(<LineChart points={points} ariaLabel="x" formatValue={(v) => `${v} s`} />);
      fireEvent.touchStart(svgOf(container), { touches: [{ clientX: xOf(2) }] });
      expect(within(tip(container)).getByText('20 s')).toBeInTheDocument();
      fireEvent.mouseMove(svgOf(container), { clientX: -500 });
      expect(within(tip(container)).getByText('10 s')).toBeInTheDocument();
      fireEvent.mouseMove(svgOf(container), { clientX: 5000 });
      expect(within(tip(container)).getByText('12 s')).toBeInTheDocument();
    });

    it('can be driven from the keyboard: focus shows the latest reading, the arrows move, Escape closes', () => {
      const { container } = render(<LineChart points={points} ariaLabel="x" formatValue={(v) => `${v} s`} />);
      const svg = svgOf(container);
      expect(svg).toHaveAttribute('tabindex', '0');
      fireEvent.focus(svg);
      expect(within(tip(container)).getByText('12 s')).toBeInTheDocument(); // the latest
      fireEvent.keyDown(svg, { key: 'ArrowLeft' });
      expect(within(tip(container)).getByText('20 s')).toBeInTheDocument();
      fireEvent.keyDown(svg, { key: 'ArrowLeft' });
      expect(within(tip(container)).getByText('40 s')).toBeInTheDocument();
      fireEvent.keyDown(svg, { key: 'Home' });
      expect(within(tip(container)).getByText('10 s')).toBeInTheDocument();
      fireEvent.keyDown(svg, { key: 'ArrowLeft' }); // already at the start
      expect(within(tip(container)).getByText('10 s')).toBeInTheDocument();
      fireEvent.keyDown(svg, { key: 'End' });
      fireEvent.keyDown(svg, { key: 'ArrowRight' }); // already at the end
      expect(within(tip(container)).getByText('12 s')).toBeInTheDocument();
      fireEvent.keyDown(svg, { key: 'Escape' });
      expect(tip(container)).toBeNull();
    });

    it('says the reading aloud as it moves, so it is not for the eyes only', () => {
      const { container } = render(<LineChart points={points} ariaLabel="x" formatValue={(v) => `${v} s`} />);
      const live = container.querySelector('[aria-live="polite"]');
      expect(live).toHaveTextContent('');
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(1) });
      expect(live).toHaveTextContent('Sep 1, 01:00: 40 s, refresh failed');
    });

    it('draws a guide line and a bigger marker at the chosen reading, and keeps the tooltip inside the chart at both ends', () => {
      const { container } = render(<LineChart points={points} ariaLabel="x" />);
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(0) });
      expect(container.querySelector('line.guide')).not.toBeNull();
      const [x0] = tip(container).getAttribute('transform').match(/-?\d+(\.\d+)?/g).map(Number);
      expect(x0).toBeGreaterThanOrEqual(0);
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(3) });
      const [x3] = tip(container).getAttribute('transform').match(/-?\d+(\.\d+)?/g).map(Number);
      expect(x3 + Number(tip(container).querySelector('rect').getAttribute('width'))).toBeLessThanOrEqual(600);
    });

    it('is wide enough for its longest line, so the reason is never cut off', () => {
      const long = [{ key: '1', label: 'Sep 1, 00:00 UTC', value: 5, kind: 'bad', note: 'refresh timed out' }, { key: '2', label: 'Sep 1, 01:00 UTC', value: 6 }];
      const { container } = render(<LineChart points={long} ariaLabel="x" />);
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(0, 2) });
      const wide = Number(tip(container).querySelector('rect').getAttribute('width'));
      fireEvent.mouseMove(svgOf(container), { clientX: xOf(1, 2) });
      const narrow = Number(tip(container).querySelector('rect').getAttribute('width'));
      expect(wide).toBeGreaterThan(narrow);
      expect(wide).toBeGreaterThanOrEqual(24 + 6 * 'Sep 1, 00:00 UTC · refresh timed out'.length - 12);
    });
  });

  it('shows no marker legend when every refresh worked', () => {
    const { container } = render(<LineChart points={points.filter((p) => !p.kind)} ariaLabel="x" />);
    expect(container.querySelector('.legend')).toBeNull();
  });

  it('keeps the limit inside the axis even when every reading is below it', () => {
    const { container } = render(<LineChart points={[{ key: 'a', label: 'a', value: 1 }, { key: 'b', label: 'b', value: 2 }]} threshold={15} ariaLabel="x" />);
    const y = Number(container.querySelector('line.threshold').getAttribute('y1'));
    expect(y).toBeGreaterThanOrEqual(0);
    expect(y).toBeLessThanOrEqual(200);
  });

  it('asks for more readings when there are fewer than two, and skips a reading that is not a number', () => {
    render(<LineChart points={[points[0]]} ariaLabel="x" />);
    expect(screen.getByText('Not enough readings to draw a chart.')).toBeInTheDocument();
    const { container } = render(<LineChart points={[points[0], { key: 'bad', label: 'bad', value: NaN }, points[3]]} ariaLabel="y" />);
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(container.querySelectorAll('svg.linechart .mk')).toHaveLength(2); // the reading that is not a number gets no marker
  });
});

describe('Scatter', () => {
  const points = [
    { key: 'a', label: 'RPT_1', x: 100, y: 105, off: false },
    { key: 'b', label: 'RPT_2', x: 100, y: 300, off: true },
  ];

  it('draws agreeing reports as circles and disagreeing ones as diamonds, with the diagonal and both axis titles', () => {
    const { container } = render(<Scatter points={points} xTitle="Credits claimed" yTitle="Credits implied" diagonalLabel="claimed = implied" ariaLabel="Claimed against implied" />);
    expect(screen.getByRole('img', { name: 'Claimed against implied' })).toBeInTheDocument();
    expect(container.querySelectorAll('svg.scatter circle.pt-on')).toHaveLength(1);
    expect(container.querySelectorAll('svg.scatter polygon.pt-off')).toHaveLength(1);
    expect(container.querySelector('line.diagonal')).not.toBeNull();
    expect(screen.getByText('claimed = implied')).toBeInTheDocument();
    expect(screen.getByText('Credits claimed')).toBeInTheDocument();
    expect(screen.getByText('Credits implied')).toBeInTheDocument();
  });

  it('uses the same scale on both axes, so the diagonal really means "equal"', () => {
    const { container } = render(<Scatter points={points} xTitle="x" yTitle="y" ariaLabel="x" />);
    const labels = [...container.querySelectorAll('svg.scatter text.axis')];
    const along = labels.filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent);
    const up = labels.filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent);
    expect(along.length).toBeGreaterThan(2);
    expect(along).toEqual(up);
    // and the line runs corner to corner: from the bottom left of the plot to its top right
    const d = container.querySelector('line.diagonal');
    expect(Number(d.getAttribute('x1'))).toBeLessThan(Number(d.getAttribute('x2')));
    expect(Number(d.getAttribute('y1'))).toBeGreaterThan(Number(d.getAttribute('y2')));
  });

  it('keeps every grid line and every point inside the plot', () => {
    const { container } = render(<Scatter points={points} xTitle="x" yTitle="y" ariaLabel="x" />);
    const svg = container.querySelector('svg.scatter');
    const [w, h] = [Number(svg.getAttribute('width')), Number(svg.getAttribute('height'))];
    for (const line of svg.querySelectorAll('line.grid')) {
      for (const [a, b] of [['x1', w], ['x2', w], ['y1', h], ['y2', h]]) {
        const v = Number(line.getAttribute(a));
        expect(v, `${a} of a grid line`).toBeGreaterThanOrEqual(0);
        expect(v, `${a} of a grid line`).toBeLessThanOrEqual(b);
      }
    }
    for (const c of svg.querySelectorAll('circle.pt')) {
      expect(Number(c.getAttribute('cy'))).toBeGreaterThan(0);
      expect(Number(c.getAttribute('cy'))).toBeLessThan(h);
    }
  });

  it('names each point in its hover title', () => {
    const { container } = render(<Scatter points={points} xTitle="Claimed" yTitle="Implied" ariaLabel="x" formatValue={(v) => `${v} credits`} />);
    expect([...container.querySelectorAll('svg.scatter g > title')].map((t) => t.textContent)).toContain('RPT_2: Claimed 100 credits, Implied 300 credits');
  });

  it('says so when there is nothing to plot, and skips a point with a missing number', () => {
    render(<Scatter points={[{ key: 'n', label: 'n', x: null, y: 5 }]} xTitle="x" yTitle="y" ariaLabel="x" />);
    expect(screen.getByText('Nothing to plot.')).toBeInTheDocument();
    const { container } = render(<Scatter points={[...points, { key: 'n', label: 'n', x: null, y: 5 }]} xTitle="x" yTitle="y" ariaLabel="y" />);
    expect(container.innerHTML).not.toMatch(/NaN/);
    expect(container.querySelectorAll('svg.scatter .pt')).toHaveLength(2);
  });
});

describe('Scatter with its own scales and reference lines', () => {
  const pts = [
    { key: 'a', label: 'RPT_1:001', x: 500, y: 200, off: false },
    { key: 'b', label: 'RPT_1:002', x: 1000, y: 1500, off: true },
    { key: 'c', label: 'RPT_1:003', x: 0, y: 90, off: true },
  ];
  const lines = [{ slope: 0.3, label: 'fleet average', tone: 'main' }, { slope: 0.9, label: '3x the average' }, { slope: 0.1, label: '1/3 of the average' }];

  it('gives each axis its own scale (views are thousands, dollars are different), unlike the claimed-against-implied plot', () => {
    const { container } = render(<Scatter points={pts} sameScale={false} xTitle="Views" yTitle="Cost" ariaLabel="x" />);
    const labels = [...container.querySelectorAll('svg.scatter text.axis')];
    const along = labels.filter((t) => t.getAttribute('text-anchor') === 'middle').map((t) => t.textContent);
    const up = labels.filter((t) => t.getAttribute('text-anchor') === 'end').map((t) => t.textContent);
    expect(along).not.toEqual(up);
    expect(container.querySelector('line.diagonal')).toBeNull(); // "equal" means nothing between views and dollars
  });

  it('draws each reference line with its label, the average solid and the band edges dashed, and keeps every line inside the plot', () => {
    const { container } = render(<Scatter points={pts} sameScale={false} lines={lines} xTitle="Views" yTitle="Cost" ariaLabel="x" />);
    const svg = container.querySelector('svg.scatter');
    const [w, h] = [Number(svg.getAttribute('width')), Number(svg.getAttribute('height'))];
    expect(svg.querySelectorAll('line.refline-main')).toHaveLength(1);
    expect(svg.querySelectorAll('line.refline-edge')).toHaveLength(2);
    for (const label of ['fleet average', '3x the average', '1/3 of the average']) expect(screen.getByText(label)).toBeInTheDocument();
    for (const l of svg.querySelectorAll('line.refline')) {
      for (const a of ['x1', 'x2']) { expect(Number(l.getAttribute(a))).toBeGreaterThanOrEqual(0); expect(Number(l.getAttribute(a))).toBeLessThanOrEqual(w); }
      for (const a of ['y1', 'y2']) { expect(Number(l.getAttribute(a))).toBeGreaterThanOrEqual(0); expect(Number(l.getAttribute(a))).toBeLessThanOrEqual(h); }
    }
  });

  it('a steep line leaves the plot through the top and a shallow one through the right edge, and both start at the origin', () => {
    const { container } = render(<Scatter points={pts} sameScale={false} lines={[{ slope: 5, label: 'steep' }, { slope: 0.1, label: 'shallow' }]} xTitle="Views" yTitle="Cost" ariaLabel="x" />);
    const svg = container.querySelector('svg.scatter');
    const width = Number(svg.getAttribute('width'));
    const [steep, shallow] = [...svg.querySelectorAll('line.refline')].map((l) => ['x1', 'y1', 'x2', 'y2'].map((a) => Number(l.getAttribute(a))));
    const [x1, y1] = [steep[0], steep[1]];
    expect([shallow[0], shallow[1]]).toEqual([x1, y1]); // both begin where the axes meet
    expect(steep[3]).toBeCloseTo(14, 0); // the top of the plot (the top padding)
    expect(steep[2]).toBeLessThan(width - 16); // ...well before the right edge
    expect(shallow[2]).toBeCloseTo(width - 16, 0); // the right edge of the plot
    expect(shallow[3]).toBeGreaterThan(steep[3]); // and still low on the page
  });

  it('draws marks on the vertical axis for a reading with no views, and the legend uses the words it is given', () => {
    const { container } = render(<Scatter points={pts} sameScale={false} xTitle="Views" yTitle="Cost" ariaLabel="x" onLabel="Within 3x" offLabel="Outside it (2)" />);
    expect(container.querySelectorAll('svg.scatter .pt')).toHaveLength(3);
    expect(screen.getByText('Within 3x')).toBeInTheDocument();
    expect(screen.getByText('Outside it (2)')).toBeInTheDocument();
  });

  it('with a great many marks they are drawn smaller and fainter, and only the ones outside the band keep a hover title', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ key: `p${i}`, label: `r${i}`, x: i, y: i * 2, off: i % 50 === 0 }));
    const { container } = render(<Scatter points={many} sameScale={false} xTitle="x" yTitle="y" ariaLabel="x" />);
    expect(Number(container.querySelector('circle.pt-on').getAttribute('r'))).toBeLessThan(3);
    expect(container.querySelector('circle.pt-on')).toHaveClass('pt-faint');
    expect(container.querySelectorAll('svg.scatter g > title')).toHaveLength(10);
    const few = render(<Scatter points={many.slice(0, 20)} sameScale={false} xTitle="x" yTitle="y" ariaLabel="y" />);
    expect(Number(few.container.querySelector('circle.pt-on').getAttribute('r'))).toBeGreaterThan(3);
  });

  it('formats the values in the hover title with the formatters it is given', () => {
    const { container } = render(<Scatter points={pts} sameScale={false} xTitle="Views" yTitle="Cost" ariaLabel="x" formatX={(v) => `${v} views`} formatY={(v) => `$${v}`} />);
    expect([...container.querySelectorAll('svg.scatter g > title')].map((t) => t.textContent)).toContain('RPT_1:002: Views 1000 views, Cost $1500');
  });
});

describe('FleetMap', () => {
  const reports = [
    { report_id: 'RPT_200', last_refresh_status: 'SUCCESS', latest_load_time_sec: 12.3 },
    { report_id: 'RPT_201', last_refresh_status: 'FAILED', latest_load_time_sec: 54.9 },
    { report_id: 'RPT_202', last_refresh_status: 'TIMED_OUT', latest_load_time_sec: 20 },
    { report_id: 'RPT_203', last_refresh_status: 'UNKNOWN', latest_load_time_sec: 5 },
    { report_id: 'RPT_204', last_refresh_status: 'SOMETHING_NEW', latest_load_time_sec: null },
  ];

  it('is one link per report, named by its refresh and its load time', () => {
    r(<FleetMap reports={reports} />);
    expect(screen.getByRole('list', { name: 'Fleet map: 5 reports' })).toBeInTheDocument();
    const ok = screen.getByRole('link', { name: 'RPT_200: refresh healthy, load time 12.3 s' });
    expect(ok).toHaveAttribute('href', '/reports/RPT_200');
    expect(screen.getByRole('link', { name: 'RPT_201: refresh failed, load time 54.9 s (over the limit)' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^RPT_202: refresh timed out/ })).toBeInTheDocument();
  });

  it('marks slow ones with a dot, and only those over the limit', () => {
    const { container } = r(<FleetMap reports={reports} threshold={15} />);
    const tiles = container.querySelectorAll('a.tile');
    const slow = [...tiles].filter((t) => t.querySelector('.tile-dot')).map((t) => t.getAttribute('aria-label').slice(0, 7));
    expect(slow).toEqual(['RPT_201', 'RPT_202']);
    expect(tiles[0]).not.toHaveClass('tile-slow');
    expect(tiles[1]).toHaveClass('tile-slow');
  });

  it('colours by refresh and draws a symbol for each, so it is not colour alone; an unrecognised status is shown as unknown', () => {
    const { container } = r(<FleetMap reports={reports} />);
    const tiles = [...container.querySelectorAll('a.tile')];
    expect(tiles.map((t) => [...t.classList].find((c) => /^tile-(success|danger|muted)$/.test(c)))).toEqual(['tile-success', 'tile-danger', 'tile-danger', 'tile-muted', 'tile-muted']);
    expect(tiles.every((t) => t.querySelector('svg path'))).toBe(true);
    const paths = tiles.slice(0, 4).map((t) => t.querySelector('svg path').getAttribute('d'));
    expect(new Set(paths).size).toBe(4); // four statuses, four different symbols
    expect(tiles[4].getAttribute('aria-label')).toContain('refresh unknown');
  });

  it('only lists the statuses that are actually present in the legend', () => {
    const { container } = r(<FleetMap reports={[reports[0], reports[1]]} />);
    const legend = container.querySelector('.legend');
    expect(legend).toHaveTextContent('Healthy');
    expect(legend).toHaveTextContent('Failed');
    expect(legend).not.toHaveTextContent('Unknown');
    expect(legend).toHaveTextContent('Latest load over 15 s');
  });
});

describe('DataDisclosure', () => {
  it('keeps the table out of the page until it is opened', async () => {
    render(<DataDisclosure><table><caption>The numbers</caption></table></DataDisclosure>);
    expect(screen.queryByRole('table')).toBeNull();
    await userEvent.click(screen.getByText('View the numbers as a table'));
    expect(await screen.findByRole('table', { name: 'The numbers' })).toBeInTheDocument();
  });
});

describe('Icon and the KPI card', () => {
  it('icons are hidden from assistive technology, and an unknown name draws nothing', () => {
    const { container } = render(<><Icon name="bell" /><Icon name="not-an-icon" /></>);
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('a KPI meter is decoration for the number: clamped to the track and hidden from assistive technology', () => {
    const { container, rerender } = render(<Kpi label="Failing" value="28%" meter={28} icon="refresh" tone="danger" />);
    const meter = container.querySelector('.meter');
    expect(meter).toHaveAttribute('aria-hidden', 'true');
    expect(meter).toHaveClass('ink-danger');
    expect(meter.firstChild.style.width).toBe('28%');
    rerender(<Kpi label="Failing" value="x" meter={250} />);
    expect(container.querySelector('.meter').firstChild.style.width).toBe('100%');
    rerender(<Kpi label="Failing" value="x" meter={-5} />);
    expect(container.querySelector('.meter').firstChild.style.width).toBe('0%');
    rerender(<Kpi label="Failing" value="x" />);
    expect(container.querySelector('.meter')).toBeNull();
  });
});

describe('Segmented', () => {
  it('is a group of buttons that say which is pressed, and tells the caller what was chosen', async () => {
    const chosen = [];
    render(<Segmented label="Readings shown" value="all" onChange={(v) => chosen.push(v)} options={[{ value: 'recent', label: 'Last 10' }, { value: 'all', label: 'All 20' }]} />);
    const group = screen.getByRole('group', { name: 'Readings shown' });
    expect(within(group).getByRole('button', { name: 'All 20' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'Last 10' })).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(within(group).getByRole('button', { name: 'Last 10' }));
    expect(chosen).toEqual(['recent']);
  });
});
