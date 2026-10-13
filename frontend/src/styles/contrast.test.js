// Reads the real design tokens and checks every text/background pairing the UI uses against WCAG AA (4.5:1 for normal text).
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TONES } from '../components/charts/StackBars.jsx';

const dir = path.resolve(import.meta.dirname);
const chartsCss = fs.readFileSync(path.join(dir, 'charts.css'), 'utf8');
const css = fs.readFileSync(path.join(dir, 'theme.css'), 'utf8') + fs.readFileSync(path.join(dir, 'app.css'), 'utf8') + chartsCss;

const tokens = {};
for (const m of css.matchAll(/(--pi-[a-z0-9-]+)\s*:\s*([^;]+);/g)) tokens[m[1]] = m[2].trim();
const resolve = (name) => {
  let v = tokens[name];
  if (v === undefined) throw new Error(`unknown token ${name}`);
  const ref = v.match(/^var\((--pi-[a-z0-9-]+)\)$/);
  return ref ? resolve(ref[1]) : v;
};

const channel = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const ratio = (fg, bg) => {
  const [hi, lo] = [luminance(resolve(fg)), luminance(resolve(bg))].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

const PAIRS = [
  ['body text on page', '--pi-text', '--pi-canvas'],
  ['body text on card', '--pi-text', '--pi-surface'],
  ['body text on table stripe', '--pi-text', '--pi-surface-sunken'],
  ['muted text on page', '--pi-text-muted', '--pi-canvas'],
  ['muted text on card', '--pi-text-muted', '--pi-surface'],
  ['muted text on table stripe', '--pi-text-muted', '--pi-surface-sunken'],
  ['link on page', '--pi-brand-strong', '--pi-canvas'],
  ['link on card', '--pi-brand-strong', '--pi-surface'],
  ['primary button', '--pi-on-brand', '--pi-brand'],
  ['primary button hover', '--pi-on-brand', '--pi-brand-hover'],
  ['top bar text', '--pi-on-dark', '--pi-dark'],
  ['top bar muted text', '--pi-text-on-dark-muted', '--pi-dark'],
  ['brand accent on top bar', '--pi-brand', '--pi-dark'],
  ['success badge', '--pi-success', '--pi-success-bg'],
  ['warning badge', '--pi-warning', '--pi-warning-bg'],
  ['danger badge', '--pi-danger', '--pi-danger-bg'],
  ['info badge', '--pi-info', '--pi-info-bg'],
  ['high-severity badge', '--pi-high', '--pi-high-bg'],
  ['critical badge', '--pi-critical', '--pi-critical-bg'],
  ['neutral badge', '--pi-text', '--pi-surface-sunken'],
  ['active menu item', '--pi-text', '--pi-brand-tint'],
  ['active menu icon and avatar initial', '--pi-brand-strong', '--pi-brand-tint'],
  ['menu group label on the menu', '--pi-text-muted', '--pi-surface'],
  ['tooltip value', '--pi-on-dark', '--pi-dark'],
  ['tooltip detail', '--pi-text-on-dark-muted', '--pi-dark'],
  ['selected segment', '--pi-text', '--pi-surface'],
  ['unselected segment', '--pi-text-muted', '--pi-surface-sunken'],
  ['KPI danger figure', '--pi-danger', '--pi-surface'],
  ['KPI warning figure', '--pi-warning', '--pi-surface'],
  ['KPI success figure', '--pi-success', '--pi-surface'],
  ['error message on card', '--pi-danger', '--pi-surface'],
  ['banner and notices', '--pi-warning', '--pi-warning-bg'],
];

describe('colour contrast (WCAG AA, 4.5:1)', () => {
  it.each(PAIRS)('%s', (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('the pressed primary button keeps its background: dark text on the darker orange would be below 4.5:1', () => {
    const rule = css.match(/\.btn-primary:active[^{]*\{([^}]*)\}/);
    expect(rule, 'no pressed-state rule found').not.toBeNull();
    expect(rule[1]).not.toMatch(/background/);
    expect(ratio('--pi-on-brand', '--pi-brand-pressed')).toBeLessThan(4.5); // the reason for the rule above
  });

  it('white text on the brand orange would fail, which is why buttons use dark text', () => {
    tokens['--white'] = '#ffffff';
    expect(ratio('--white', '--pi-brand')).toBeLessThan(4.5);
  });
});

// Charts: shapes and lines must reach 3:1 against what they are drawn on (WCAG 1.4.11). Text inside charts uses the text pairs above.
const GRAPHICS = [
  ...TONES.map((tone) => [`${tone} ink on a card`, `--pi-ink-${tone}`, '--pi-surface']),
  ['danger marker and limit line on a card', '--pi-danger', '--pi-surface'],
  ['axis and diagonal lines on a card', '--pi-text-muted', '--pi-surface'],
  ['slow-report dot on a healthy tile', '--pi-brand-strong', '--pi-success-bg'],
  ['slow-report dot on a failed tile', '--pi-brand-strong', '--pi-danger-bg'],
  ['slow-report dot on an unknown tile', '--pi-brand-strong', '--pi-surface-sunken'],
  ['hollow marker outline on a card', '--pi-text-muted', '--pi-surface'],
];

describe('chart colours (WCAG 1.4.11, 3:1 for graphics)', () => {
  it.each(GRAPHICS)('%s', (_name, fg, bg) => {
    expect(ratio(fg, bg)).toBeGreaterThanOrEqual(3);
  });

  it('every tone a chart can ask for has a colour and a class, and nothing in the stylesheet is left unused', () => {
    for (const tone of TONES) {
      expect(tokens[`--pi-ink-${tone}`], `token for ${tone}`).toBeDefined();
      expect(chartsCss, `class for ${tone}`).toMatch(new RegExp(String.raw`\.ink-${tone}\s*\{`));
    }
    const defined = [...chartsCss.matchAll(/^\.ink-([a-z]+)\s*\{/gm)].map((m) => m[1]);
    expect(defined.sort()).toEqual([...TONES].sort());
  });

  it('the brand orange itself is too pale to draw with on a card, so charts use a slightly deeper orange that still reads as the brand', () => {
    expect(ratio('--pi-brand', '--pi-surface')).toBeLessThan(3);
    expect(resolve('--pi-ink-brand')).not.toBe(resolve('--pi-brand'));
    expect(ratio('--pi-ink-brand', '--pi-surface')).toBeGreaterThanOrEqual(3);
    expect(ratio('--pi-ink-brand', '--pi-surface')).toBeLessThan(4); // it is a graphics colour, not a text colour: text uses the strong orange
  });

  it('the old neutral track colour was below 3:1, so unknown is drawn in the muted text colour', () => {
    expect(ratio('--pi-border-strong', '--pi-surface')).toBeLessThan(3);
    expect(resolve('--pi-ink-muted')).toBe(resolve('--pi-text-muted'));
  });
});
