import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext.jsx';
import { can } from '../auth/permissions.js';
import { EmptyState, PageHeader } from '../components/ui.jsx';

export function NoAccess() {
  return (
    <>
      <PageHeader title="No access" />
      <EmptyState title="Your role cannot open this page." action={<Link className="btn btn-primary" to="/">Back to overview</Link>}>
        Ask an admin if you need it. Nothing on this page was loaded.
      </EmptyState>
    </>
  );
}

export function NotFound() {
  return (
    <>
      <PageHeader title="Page not found" />
      <EmptyState title="There is nothing at this address." action={<Link className="btn btn-primary" to="/">Back to overview</Link>}>
        Check the link, or use the menu above.
      </EmptyState>
    </>
  );
}

// Route guard that mirrors the server's rules, so people do not land on a page full of 403 errors.
export function Gate({ capability, children }) {
  const { user } = useAuth();
  return can(user, capability) ? children : <NoAccess />;
}
