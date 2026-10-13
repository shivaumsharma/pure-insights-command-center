import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { createApi } from '../lib/api.js';

const AuthContext = createContext(null);
const STORAGE_KEY = 'pi.session';

// The token lives in sessionStorage (this tab only, cleared when it closes). It is readable by any script on the page,
// which is the usual trade-off for a bearer token; the server also expires it (default 8 h).
function readSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeSession(session) {
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch { /* storage blocked: the session just will not survive a reload */ }
}

export function AuthProvider({ children, fetchImpl }) {
  const [session, setSession] = useState(readSession);
  const [notice, setNotice] = useState(null);
  const tokenRef = useRef(null);
  tokenRef.current = session?.token ?? null;

  const logout = useCallback((message) => {
    writeSession(null);
    setSession(null);
    setNotice(typeof message === 'string' ? message : null);
  }, []);

  const api = useMemo(
    () => createApi({ getToken: () => tokenRef.current, onUnauthorized: () => logout('Your session has expired. Please sign in again.'), fetchImpl }),
    [logout, fetchImpl],
  );

  const login = useCallback(async (email, password) => {
    const res = await api.login(email, password);
    const next = { token: res.token, user: res.user };
    writeSession(next);
    setSession(next);
    setNotice(null);
    return res.user;
  }, [api]);

  const value = useMemo(
    () => ({ user: session?.user ?? null, token: session?.token ?? null, api, login, logout, notice, clearNotice: () => setNotice(null) }),
    [session, api, login, logout, notice],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
