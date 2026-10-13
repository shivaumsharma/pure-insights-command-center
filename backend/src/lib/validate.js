import { badRequest } from './errors.js';

export const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
export const REPORT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Query-string values can arrive as arrays (?a=1&a=2); only a single string is accepted.
export function single(query, name) {
  const value = query[name];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw badRequest(`'${name}' must be given once`);
  return value;
}

export function parseInteger(query, name, { min, max, fallback }) {
  const raw = single(query, name);
  if (raw === undefined || raw === '') return fallback;
  if (!/^-?\d+$/.test(raw)) throw badRequest(`'${name}' must be a whole number`);
  const n = Number(raw);
  if (n < min || n > max) throw badRequest(`'${name}' must be between ${min} and ${max}`);
  return n;
}

export function parsePage(query) {
  return {
    limit: parseInteger(query, 'limit', { min: 1, max: 200, fallback: 50 }),
    offset: parseInteger(query, 'offset', { min: 0, max: 1_000_000, fallback: 0 }),
  };
}

export function parseEnum(query, name, allowed) {
  const raw = single(query, name);
  if (raw === undefined || raw === '') return undefined;
  if (!allowed.includes(raw)) throw badRequest(`'${name}' must be one of: ${allowed.join(', ')}`);
  return raw;
}

export function parseBoolean(query, name) {
  const raw = single(query, name);
  if (raw === undefined || raw === '') return undefined;
  if (raw !== 'true' && raw !== 'false') throw badRequest(`'${name}' must be true or false`);
  return raw === 'true';
}

export function parseSearch(query, name) {
  const raw = single(query, name);
  if (raw === undefined || raw === '') return undefined;
  if (raw.length > 100) throw badRequest(`'${name}' is too long (max 100 characters)`);
  return raw.toLowerCase();
}

export function paginate(rows, { limit, offset }) {
  return { data: rows.slice(offset, offset + limit), page: { limit, offset, total: rows.length } };
}
