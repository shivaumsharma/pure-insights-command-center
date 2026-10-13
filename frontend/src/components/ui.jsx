import { Link } from 'react-router-dom';
import { clamp } from '../lib/chartMath.js';
import { ALERT_TYPE_LABEL, LIFECYCLE_LABEL, STATUS_LABEL, fmtUsd } from '../lib/format.js';
import { Icon } from './Icon.jsx';

export function PageHeader({ title, description, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

export function Card({ title, subtitle, actions, children, className = '', id }) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section className={`card ${className}`} id={id} aria-labelledby={title ? headingId : undefined}>
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 id={headingId}>{title}</h2>}
            {subtitle && <p className="muted small">{subtitle}</p>}
          </div>
          {actions && <div className="card-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

// icon: a name from Icon.jsx. meter: 0-100, a small bar under the figure (for a share of the whole). Both are decoration for the number.
export function Kpi({ label, value, hint, to, tone, icon, meter }) {
  const body = (
    <>
      <span className="kpi-top">
        <span className="kpi-label">{label}</span>
        {icon && <span className="kpi-icon" data-tone={tone} aria-hidden="true"><Icon name={icon} /></span>}
      </span>
      <span className={`kpi-value ${tone ? `tone-${tone}` : ''}`}>{value}</span>
      {hint && <span className="kpi-hint">{hint}</span>}
      {Number.isFinite(meter) && (
        <span className={`meter ink-${tone === 'danger' || tone === 'warning' || tone === 'success' ? tone : 'brand'}`} aria-hidden="true">
          <span style={{ width: `${clamp(meter, 0, 100)}%` }} />
        </span>
      )}
    </>
  );
  return to ? <Link className="card kpi kpi-link" to={to}>{body}</Link> : <div className="card kpi">{body}</div>;
}

// A dollar amount with its sign in the accent colour. The text is the same as fmtUsd's, so it reads and copies as one figure.
export function Money({ value }) {
  const text = fmtUsd(value);
  if (!text.startsWith('$')) return text;
  return <span className="money"><span className="cur">$</span>{text.slice(1)}</span>;
}

export function Badge({ tone = 'neutral', children, title }) {
  return <span className={`badge badge-${tone}`} title={title}>{children}</span>;
}

const STATUS_TONE = { SUCCESS: 'success', FAILED: 'danger', TIMED_OUT: 'danger', UNKNOWN: 'neutral' };
export const StatusBadge = ({ status }) => <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status}</Badge>;

const SEVERITY_TONE = { low: 'info', medium: 'warning', high: 'high', critical: 'critical' };
export const SeverityBadge = ({ severity }) => <Badge tone={SEVERITY_TONE[severity] ?? 'neutral'}>{severity[0].toUpperCase() + severity.slice(1)}</Badge>;

const LIFECYCLE_TONE = { TRIGGERED: 'neutral', ESCALATED: 'warning', REPEATED: 'neutral', RESOLVED: 'success' };
export const LifecycleBadge = ({ lifecycle }) => <Badge tone={LIFECYCLE_TONE[lifecycle] ?? 'neutral'}>{LIFECYCLE_LABEL[lifecycle] ?? lifecycle}</Badge>;

export function OwnerCell({ report }) {
  if (report.is_orphaned) {
    return <Badge tone="warning" title={report.last_known_owner_email ? `Last known owner: ${report.last_known_owner_email}` : undefined}>No owner</Badge>;
  }
  return <span className="mono small">{report.owner_email}</span>;
}

export function Button({ variant = 'primary', type = 'button', className = '', children, ...props }) {
  return <button type={type} className={`btn btn-${variant} ${className}`.trim()} {...props}>{children}</button>;
}

export function Field({ id, label, hint, error, children }) {
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && !error && <p className="hint" id={`${id}-hint`}>{hint}</p>}
      {error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

export function DataTable({ caption, columns, rows, rowKey, className = '' }) {
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className={`table ${className}`}>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c.key} scope="col" className={c.align === 'right' ? 'num' : ''}>{c.header}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => <td key={c.key} className={`${c.align === 'right' ? 'num' : ''} ${c.mono ? 'mono' : ''}`}>{c.render ? c.render(row) : row[c.key]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ total, limit, offset, onChange, noun = 'items' }) {
  if (total === 0) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <nav className="pagination" aria-label="Pagination">
      <p className="muted small" aria-live="polite">Showing {from}–{to} of {total} {noun}</p>
      <div className="pagination-buttons">
        <Button variant="secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>Previous</Button>
        <Button variant="secondary" disabled={offset + limit >= total} onClick={() => onChange(offset + limit)}>Next</Button>
      </div>
    </nav>
  );
}

export function EmptyState({ title, children, action, icon }) {
  return (
    <div className="empty">
      {icon && <span className="empty-icon"><Icon name={icon} size={24} /></span>}
      <p className="empty-title">{title}</p>
      {children && <p className="muted">{children}</p>}
      {action}
    </div>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  return (
    <div className="error-box" role="alert">
      <p><strong>Something went wrong.</strong> {error.message}</p>
      {onRetry && <Button variant="secondary" onClick={onRetry}>Try again</Button>}
    </div>
  );
}

export function Skeleton({ rows = 4 }) {
  return (
    <div className="skeleton" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <div key={i} className="skeleton-row" />)}
    </div>
  );
}

// Shown wherever dollars appear: the credit price is a placeholder until the contracted rate is set.
export function PriceBanner({ meta }) {
  if (!meta?.price_is_placeholder) return null;
  return (
    <p className="banner" role="note">
      Dollar figures use a placeholder credit price of ${meta.credit_price_usd} per credit. Compare reports with each other; do not quote the totals.
    </p>
  );
}

export const alertKind = (a) => ALERT_TYPE_LABEL[a.alert_type] ?? a.alert_type;
