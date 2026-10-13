export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function toQuery(query) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const s = params.toString();
  return s ? `?${s}` : '';
}

// Thin fetch wrapper: adds the bearer token, turns the API's error shape into ApiError, and reports 401s once.
export function createApi({ getToken, onUnauthorized = () => {}, fetchImpl = (...a) => fetch(...a) }) {
  async function request(method, path, { query, body, auth = true } = {}) {
    const headers = {};
    const token = auth ? getToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    let res;
    try {
      res = await fetchImpl(`${path}${toQuery(query)}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, 'NETWORK', 'Could not reach the server. Check your connection and try again.');
    }

    let json = null;
    try { json = await res.json(); } catch { /* empty or non-JSON body */ }

    if (!res.ok) {
      const e = json?.error;
      const err = new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? `Request failed (${res.status})`, e?.details);
      if (res.status === 401 && auth) onUnauthorized(err);
      throw err;
    }
    return json;
  }

  return {
    get: (path, query) => request('GET', path, { query }),
    put: (path, body) => request('PUT', path, { body }),
    post: (path, body) => request('POST', path, { body }),
    del: (path) => request('DELETE', path),
    login: (email, password) => request('POST', '/api/auth/login', { body: { email, password }, auth: false }),
  };
}
