import { Link, NavLink, Outlet } from 'react-router-dom';
import { can, ROLE_LABEL } from '../auth/permissions.js';
import { useAuth } from '../auth/AuthContext.jsx';
import { Icon } from './Icon.jsx';
import { LiveStatus } from './LiveStatus.jsx';
import { Button } from './ui.jsx';

// The menu is grouped by what you are doing: watching the platform, following the money, or validating what the tool says.
// An item shows only if the role may open it (the server enforces the same rules).
const GROUPS = (user) => [
  {
    label: 'Monitor',
    items: [
      { to: '/', label: 'Overview', icon: 'grid', end: true },
      { to: '/reports', label: 'Reports', icon: 'file' },
      { to: '/alerts', label: 'Alerts', icon: 'bell' },
    ],
  },
  {
    label: 'Money',
    items: [
      can(user, 'costs') && { to: '/costs', label: 'Costs', icon: 'coin' },
      can(user, 'orphans') && { to: '/orphans', label: 'Orphaned reports', icon: 'userOff' },
    ].filter(Boolean),
  },
  {
    label: 'Validate',
    items: [
      can(user, 'dataQuality') && { to: '/data-quality', label: 'Data quality', icon: 'shield' },
      can(user, 'aiReview') && { to: '/ai-review', label: 'AI review', icon: 'sparkles' },
    ].filter(Boolean),
  },
].filter((g) => g.items.length > 0);

export const partOfDay = (hour) => (hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening');
export const firstName = (user) => (user.name ?? user.email.split('@')[0]).split(/[\s._]/)[0];

export function Layout() {
  const { user, logout } = useAuth();
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <div className="shell">
        <aside className="sidebar">
          <Link className="brand" to="/">
            <span className="brand-mark" aria-hidden="true"><Icon name="grid" size={20} /></span>
            <span className="brand-text">
              <span className="brand-name">Pure Insights</span>
              <span className="brand-sub">Command center</span>
            </span>
          </Link>
          <nav className="nav" aria-label="Main">
            {GROUPS(user).map((g) => (
              <div className="nav-group" role="group" aria-label={g.label} key={g.label}>
                <p className="nav-group-label" aria-hidden="true">{g.label}</p>
                {g.items.map((i) => <NavLink key={i.to} to={i.to} end={i.end}><Icon name={i.icon} size={18} />{i.label}</NavLink>)}
              </div>
            ))}
          </nav>
          <div className="sidebar-foot">
            <div className="user-chip">
              <span className="avatar" aria-hidden="true">{firstName(user)[0].toUpperCase()}</span>
              <div className="user-text">
                <span>{user.email}</span>
                <span className="role">{ROLE_LABEL[user.role]}</span>
              </div>
            </div>
            <Button variant="secondary" onClick={() => logout()}>Sign out</Button>
          </div>
        </aside>

        <div className="shell-main">
          <div className="shell-head">
            <p className="greeting">Good {partOfDay(new Date().getHours())}, <strong>{firstName(user)}</strong></p>
            <LiveStatus />
          </div>
          <main id="main" className="page" tabIndex={-1}>
            <Outlet />
          </main>
          <p className="footer-note">Synthetic data. Times are UTC on a synthetic timeline. Dollar figures use a placeholder credit price.</p>
        </div>
      </div>
    </>
  );
}
