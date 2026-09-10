import { useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { adminSignOut, useSession, type AuditEvent } from '../api';
import { AdministratorsPage } from './administrators';
import { ApplicationsPage } from './applications';

function Overview(): React.JSX.Element {
  const { session, loading } = useSession();
  const [audit, setAudit] = useState<AuditEvent[] | null>(null);

  useEffect(() => {
    if (!session) return;
    fetch('/api/audit')
      .then((res) => (res.ok ? res.json() : { events: [] }))
      .then((body: { events: AuditEvent[] }) => setAudit(body.events))
      .catch(() => setAudit([]));
  }, [session]);

  if (loading) return <p className="loading-notice">Checking your session…</p>;
  if (!session) {
    return (
      <p className="empty-note">
        You are not signed in. <a href="/sign-in">Sign in as an Administrator</a>.
      </p>
    );
  }

  return (
    <div>
      <h2>Recent activity</h2>
      {audit === null ? (
        <p className="loading-notice">Loading audit events…</p>
      ) : audit.length === 0 ? (
        <p className="empty-note">No security events recorded yet.</p>
      ) : (
        <ul className="audit-list">
          {audit.map((event) => (
            <li key={event.id}>
              <span className="audit-kind">{event.kind}</span>
              <span className="audit-when">{new Date(event.occurredAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { session, loading } = useSession();

  return (
    <div className="dashboard-shell">
      <nav className="dashboard-side" aria-label="Dashboard">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">IK</div>
          <span className="brand-name">IdentiK</span>
        </div>
        <p className="side-section">Manage</p>
        <div className="side-nav">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/users" className="side-nav-link">
            Identities
          </NavLink>
          <NavLink to="/applications" className="side-nav-link">
            Applications
          </NavLink>
          <NavLink to="/administrators" className="side-nav-link">
            Administrators
          </NavLink>
          <NavLink to="/audit" className="side-nav-link">
            Audit
          </NavLink>
        </div>
        <p className="side-section">Account</p>
        <div className="side-nav">
          <button
            className="side-nav-link"
            style={{ all: 'unset', cursor: 'pointer' }}
            onClick={async () => {
              await adminSignOut();
              window.location.href = '/sign-in';
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      <main className="dashboard-main">
        <header className="dashboard-head">
          <h1>Overview</h1>
          <span className="org-badge">
            {loading ? '…' : (session?.organizationName ?? 'Not signed in')}
          </span>
        </header>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route
            path="/users"
            element={<p className="empty-note">Identities arrive with ticket 03.</p>}
          />
          <Route path="/applications" element={<ApplicationsPage />} />
          <Route path="/administrators" element={<AdministratorsPage />} />
          <Route
            path="/audit"
            element={<p className="empty-note">The full audit viewer arrives with ticket 08.</p>}
          />
        </Routes>
      </main>
    </div>
  );
}
