import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Money } from '../components/ui.jsx';
import { fmtCredits, fmtInt, fmtPct, fmtSec, fmtUsd } from './format.js';

// The source data names its cost column aws_hosting_cost_usd, so every money figure in the app is US dollars.
describe('money is in US dollars', () => {
  it('formats with a dollar sign, thousands separators and two decimals', () => {
    expect(fmtUsd(0)).toBe('$0.00');
    expect(fmtUsd(1234.5)).toBe('$1,234.50');
    expect(fmtUsd(71948.79)).toBe('$71,948.79');
    expect(fmtUsd(4100000)).toBe('$4,100,000.00');
  });
  it('never uses another currency sign, whatever the browser language is', () => {
    for (const n of [1, 1234.5, 1e6]) expect(fmtUsd(n)).toMatch(/^\$[\d,]+\.\d{2}$/);
  });
  it('shows a dash when there is no figure, not $0.00 or NaN', () => {
    for (const n of [null, undefined, NaN]) expect(fmtUsd(n)).toBe('—');
  });
});

describe('the other figures', () => {
  it('counts have separators, times one decimal, credits two decimals unless whole', () => {
    expect(fmtInt(1976)).toBe('1,976');
    expect(fmtSec(54.9)).toBe('54.9 s');
    expect(fmtCredits(22391.9301)).toBe('22,391.93');
    expect(fmtCredits(64)).toBe('64');
    expect(fmtPct(28.1)).toBe('28.1%');
  });
});

describe('Money', () => {
  it('puts the dollar sign in its own accent-coloured span but reads as the same figure', () => {
    const { container } = render(<Money value={1234.5} />);
    expect(container.querySelector('.cur')).toHaveTextContent('$');
    expect(container.textContent).toBe('$1,234.50');
  });
  it('shows a plain dash when there is nothing to show', () => {
    const { container } = render(<Money value={null} />);
    expect(container.textContent).toBe('—');
    expect(container.querySelector('.cur')).toBeNull();
  });
});
