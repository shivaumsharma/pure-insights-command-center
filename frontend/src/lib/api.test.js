import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApi } from './api.js';
import { fmtCredits, fmtDuration, fmtEventTime, fmtInt, fmtPct, fmtSec, fmtUsd, plural } from './format.js';

const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error('no body')) : Promise.resolve(body)) });

function setup({ token = 'tok', response = reply(200, { ok: true }) } = {}) {
  const fetchImpl = vi.fn(() => response);
  const onUnauthorized = vi.fn();
  const api = createApi({ getToken: () => token, onUnauthorized, fetchImpl });
  return { api, fetchImpl, onUnauthorized };
}

describe('api client', () => {
  it('sends the bearer token and builds the query string, skipping blank values', async () => {
    const { api, fetchImpl } = setup();
    await api.get('/api/reports', { status: 'FAILED', q: '', orphaned: undefined, limit: 25, offset: 0, x: null });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('/api/reports?status=FAILED&limit=25&offset=0');
    expect(init.headers.authorization).toBe('Bearer tok');
  });

  it('encodes query values', async () => {
    const { api, fetchImpl } = setup();
    await api.get('/api/reports', { q: 'a&b c' });
    expect(fetchImpl.mock.calls[0][0]).toBe('/api/reports?q=a%26b+c');
  });

  it('sends JSON bodies with a content type', async () => {
    const { api, fetchImpl } = setup();
    await api.put('/api/reports/RPT_1/owner', { email: 'a@b.co' });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('PUT');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.co' });
  });

  it('turns the API error shape into an ApiError', async () => {
    const { api } = setup({ response: reply(403, { error: { code: 'FORBIDDEN', message: 'You do not have permission to do this' } }) });
    await expect(api.get('/api/orphans')).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN', message: 'You do not have permission to do this' });
  });

  it('a 401 on an authenticated request signals "signed out"; a failed login does not', async () => {
    const authed = setup({ response: reply(401, { error: { code: 'UNAUTHENTICATED', message: 'Invalid or expired token' } }) });
    await expect(authed.api.get('/api/health')).rejects.toBeInstanceOf(ApiError);
    expect(authed.onUnauthorized).toHaveBeenCalledTimes(1);

    const login = setup({ token: null, response: reply(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' } }) });
    await expect(login.api.login('a@b.co', 'x')).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    expect(login.onUnauthorized).not.toHaveBeenCalled();
    expect(login.fetchImpl.mock.calls[0][1].headers.authorization).toBeUndefined();
  });

  it('survives an empty or non-JSON error body', async () => {
    const { api } = setup({ response: reply(502, undefined) });
    await expect(api.get('/api/health')).rejects.toMatchObject({ status: 502, message: 'Request failed (502)' });
  });

  it('reports a network failure in plain words', async () => {
    const api = createApi({ getToken: () => 't', fetchImpl: () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(api.get('/api/health')).rejects.toMatchObject({ status: 0, code: 'NETWORK' });
  });
});

describe('formatters', () => {
  it('format numbers and show a dash for missing values', () => {
    expect(fmtInt(1234567)).toBe('1,234,567');
    expect(fmtInt(null)).toBe('—');
    expect(fmtSec(54.94)).toBe('54.9 s');
    expect(fmtPct(74.4)).toBe('74.4%');
    expect(fmtUsd(71948.79)).toBe('$71,948.79');
    expect(fmtUsd(undefined)).toBe('—');
    expect(fmtCredits(1206352.484)).toBe('1,206,352.48');
    expect(fmtCredits(17842.4)).toBe('17,842.40'); // always two decimals for amounts
    expect(fmtCredits(64)).toBe('64'); // counts stay whole
  });

  it('event times are shown in UTC because the timeline is synthetic', () => {
    expect(fmtEventTime('2026-09-01T03:00:30.000Z')).toBe('Sep 1, 03:00 UTC');
    expect(fmtEventTime(null)).toBe('—');
  });

  it('plural agrees with the count', () => {
    expect(plural(1, 'repeat reading')).toBe('1 repeat reading');
    expect(plural(2, 'repeat reading')).toBe('2 repeat readings');
    expect(plural(1200, 'report')).toBe('1,200 reports');
  });

  it('durations read naturally', () => {
    expect(fmtDuration(30 * 60000)).toBe('30 min');
    expect(fmtDuration(4 * 3600000)).toBe('4 h');
    expect(fmtDuration(90 * 60000)).toBe('1.5 h');
  });
});
