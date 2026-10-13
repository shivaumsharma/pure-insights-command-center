import { useEffect, useRef, useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { Icon } from '../components/Icon.jsx';
import { Button, Field } from '../components/ui.jsx';

export default function Login() {
  const { user, login, notice, clearNotice } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [busy, setBusy] = useState(false);
  const emailRef = useRef(null);
  const passwordRef = useRef(null);

  useEffect(() => { document.title = 'Sign in · Pure Insights'; }, []);
  if (user) return <Navigate to={location.state?.from ?? '/'} replace />;

  async function submit(event) {
    event.preventDefault();
    const next = {};
    if (!email.trim()) next.email = 'Enter your email address.';
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) next.email = 'Enter a valid email address, like name@company.com.';
    if (!password) next.password = 'Enter your password.';
    setErrors(next);
    setFormError(null);
    if (next.email) return emailRef.current?.focus();
    if (next.password) return passwordRef.current?.focus();

    setBusy(true);
    try {
      clearNotice();
      await login(email.trim(), password);
      navigate(location.state?.from ?? '/', { replace: true });
    } catch (err) {
      setFormError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit} noValidate aria-labelledby="login-title">
        <div>
          <span className="login-mark" aria-hidden="true"><Icon name="grid" size={22} /></span>
          <h1 id="login-title">Pure Insights</h1>
          <p className="muted">Sign in to the command center.</p>
        </div>
        {notice && <p className="notice" role="status">{notice}</p>}
        {formError && <p className="error-box" role="alert">{formError}</p>}
        <Field id="email" label="Email" error={errors.email}>
          <input ref={emailRef} id="email" type="email" autoComplete="username" value={email}
            aria-invalid={errors.email ? 'true' : undefined} aria-describedby={errors.email ? 'email-error' : undefined}
            onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field id="password" label="Password" error={errors.password}>
          <input ref={passwordRef} id="password" type="password" autoComplete="current-password" value={password}
            aria-invalid={errors.password ? 'true' : undefined} aria-describedby={errors.password ? 'password-error' : undefined}
            onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
        <p className="hint">Local demo: accounts are listed in backend/config/demo-users.json.</p>
      </form>
    </div>
  );
}
