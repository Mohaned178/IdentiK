import { useEffect, useState } from 'react';
import { NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  adminSignOut,
  fetchApplications,
  useSession,
  type AdministratorSession,
  type Application,
  type AuditEvent,
} from '../api';
import { AdministratorsPage } from './administrators';
import { ApplicationsPage } from './applications';
import { stamp } from '../format';

interface Sheet {
  path: string;
  index: string;
  label: string;
  ref: string;
  title: string;
}

const SHEETS: Sheet[] = [
  { path: '/', index: 'A', label: 'Trust Boundary', ref: 'A-001', title: 'Trust Boundary' },
  { path: '/administrators', index: 'B', label: 'Administrators', ref: 'B-002', title: 'Administrators' },
  { path: '/applications', index: 'C', label: 'Applications', ref: 'C-003', title: 'Applications' },
  { path: '/users', index: 'D', label: 'Identities', ref: 'D-004', title: 'Identities' },
  { path: '/audit', index: 'E', label: 'Audit', ref: 'E-005', title: 'Revision Log' },
];

function sheetFor(pathname: string): Sheet {
  const exact = SHEETS.find((s) => s.path === pathname);
  if (exact) return exact;
  return SHEETS.find((s) => s.path !== '/' && pathname.startsWith(s.path)) ?? SHEETS[0]!;
}

function useAudit(enabled: boolean): AuditEvent[] | null {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    fetch('/api/audit')
      .then((res) => (res.ok ? res.json() : { events: [] }))
      .then((body: { events: AuditEvent[] }) => setEvents(body.events))
      .catch(() => setEvents([]));
  }, [enabled]);
  return events;
}

function useApplications(enabled: boolean): Application[] {
  const [applications, setApplications] = useState<Application[]>([]);
  useEffect(() => {
    if (!enabled) return;
    fetchApplications()
      .then(setApplications)
      .catch(() => setApplications([]));
  }, [enabled]);
  return applications;
}

function detailOf(event: AuditEvent): Record<string, unknown> {
  return (event.detail ?? {}) as Record<string, unknown>;
}

function actorLabel(actor: string, selfId?: string): string {
  return selfId && actor === selfId ? 'You' : actor;
}

function stringField(event: AuditEvent, field: string): string | null {
  const value = detailOf(event)[field];
  return typeof value === 'string' ? value : null;
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function buildTrace(events: AuditEvent[]): { points: string; area: string; empty: boolean; peak: number } {
  const W = 600;
  const H = 70;
  const N = 24;
  const now = Date.now();
  const counts = new Array<number>(N).fill(0);
  for (const event of events) {
    const ageHours = (now - new Date(event.occurredAt).getTime()) / 3_600_000;
    if (ageHours < 0 || ageHours >= N) continue;
    const index = N - 1 - Math.floor(ageHours);
    counts[index] = (counts[index] ?? 0) + 1;
  }
  const peak = Math.max(1, ...counts);
  const step = W / (N - 1);
  const points = counts
    .map((count, i) => {
      const x = i * step;
      const y = H - 8 - (count / peak) * (H - 18);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return { points, area: `0,${H} ${points} ${W},${H}`, empty: peak === 1 && counts.every((c) => c === 0), peak };
}

function SignalBand({ events }: { events: AuditEvent[] | null }): React.JSX.Element {
  const list = events ?? [];
  const trace = buildTrace(list);
  return (
    <section className="signal-band" aria-label="Authentication activity over the last 24 hours">
      <div className="signal-band-head">
        <span>
          {trace.empty
            ? 'Signal · no authentication activity in 24h'
            : 'Signal · authentication activity · last 24h'}
        </span>
        <span className="signal-live">Live</span>
      </div>
      <svg
        className="signal-trace"
        viewBox="0 0 600 70"
        preserveAspectRatio="none"
        role="img"
        aria-label={
          trace.empty
            ? 'Flat trace: no recorded authentication activity'
            : `Trace peaked at ${trace.peak} events per hour`
        }
      >
        <line className="signal-grid" x1="0" y1="35" x2="600" y2="35" />
        <line className="signal-grid" x1="150" y1="0" x2="150" y2="70" />
        <line className="signal-grid" x1="300" y1="0" x2="300" y2="70" />
        <line className="signal-grid" x1="450" y1="0" x2="450" y2="70" />
        <polygon className="signal-fill" points={trace.area} />
        <polyline className="signal-line" points={trace.points} />
      </svg>
      <div className="signal-axis">
        <span>24h ago</span>
        <span>12h</span>
        <span>now</span>
      </div>
    </section>
  );
}

function Schematic({
  session,
  applications,
  events,
}: {
  session: AdministratorSession;
  applications: Application[];
  events: AuditEvent[];
}): React.JSX.Element {
  const invited = uniqueBy(
    events
      .filter((event) => event.kind === 'administrator.invitation.accepted')
      .map((event) => ({
        email: stringField(event, 'email') ?? 'unknown',
        role: stringField(event, 'role') ?? 'member',
      })),
    (entry) => entry.email,
  );

  const identities = uniqueBy(
    events
      .filter(
        (event) =>
          event.kind === 'identity.verification.completed' ||
          event.kind === 'identity.reservation.created',
      )
      .map((event) => ({
        email: stringField(event, 'email') ?? 'unknown',
        verified: event.kind === 'identity.verification.completed',
      })),
    (entry) => entry.email,
  );
  // A verified event supersedes an earlier reservation for the same email.
  const directory = uniqueBy(
    [...identities].sort((a, b) => Number(b.verified) - Number(a.verified)),
    (entry) => entry.email,
  );

  const firstWeb = applications.find((application) => application.type === 'web');

  return (
    <section className="schematic" aria-label="Organization trust boundary">
      <div className="schematic-head">
        <span>Trust boundary · single-line diagram</span>
        <span className="schematic-legend">
          <span className="legend-key">
            <span className="legend-swatch" aria-hidden="true" /> Active
          </span>
          <span className="legend-key">
            <span className="legend-swatch revoked" aria-hidden="true" /> Revoked
          </span>
        </span>
      </div>
      <div className="schematic-canvas">
        <div className="boundary">
          <span className="boundary-label">Organization · {session.organizationName}</span>
          <div className="lanes">
            <div className="lane">
              <div className="lane-head">
                <span className="lane-name">Administrators</span>
                <span className="lane-count">{1 + invited.length}</span>
              </div>
              <div className="lane-body">
                <div className="entity">
                  <span>You</span>
                  <span className="entity-role">{session.role}</span>
                </div>
                {invited.map((admin) => (
                  <div className="entity" key={admin.email}>
                    <span>{admin.email}</span>
                    <span className="entity-role">{admin.role}</span>
                  </div>
                ))}
                {invited.length === 0 && (
                  <span className="lane-empty">No other Administrators invited yet.</span>
                )}
              </div>
            </div>

            <div className="lane">
              <div className="lane-head">
                <span className="lane-name">End Users</span>
                <span className="lane-count">{directory.length}</span>
              </div>
              <div className="lane-body">
                {directory.slice(0, 4).map((identity) => (
                  <div className="entity" key={identity.email}>
                    <span>{identity.email}</span>
                    <span className="entity-role">{identity.verified ? 'verified' : 'reserved'}</span>
                  </div>
                ))}
                {directory.length > 4 && (
                  <span className="lane-empty">+{directory.length - 4} more in the revision log.</span>
                )}
                {directory.length === 0 && (
                  <span className="lane-empty">No identities recorded yet.</span>
                )}
              </div>
            </div>
          </div>

          <div className="bus-wrap">
            <div className="bus-line" aria-hidden="true" />
            <div className="bus-nodes">
              {applications.map((application) => (
                <a className="node" key={application.id} href="/applications">
                  <span className={`node-status ${application.type === 'web' ? 'confidential' : 'public'}`} aria-hidden="true" />
                  <span className="node-type">
                    {application.type === 'web' ? 'Confidential' : 'Public'}
                  </span>
                  <span className="node-name">{application.name}</span>
                  <span className="node-id">{application.clientId}</span>
                </a>
              ))}
              {applications.length === 0 && (
                <span className="lane-empty">No Applications attached to this Organization yet.</span>
              )}
            </div>
          </div>

          {firstWeb && (
            <div className="tree">
              <div className="tree-head">
                <span className="tree-name">{firstWeb.name}</span>
                <span className="entity-role">concurrent client secrets</span>
              </div>
              <div className="tree-rows">
                {firstWeb.secrets.map((secret) => (
                  <div className={`cred${secret.revokedAt ? ' revoked' : ''}`} key={secret.id}>
                    <span className="cred-ink" aria-hidden="true" />
                    <span className="cred-label">{secret.label}</span>
                    <span className="cred-validity">
                      {stamp(secret.createdAt)}
                      {secret.revokedAt ? ` → ${stamp(secret.revokedAt)}` : ' → open'}
                    </span>
                    <span className={`cred-state ${secret.revokedAt ? 'revoked' : 'active'}`}>
                      {secret.revokedAt ? 'Revoked' : 'Active'}
                    </span>
                  </div>
                ))}
                {firstWeb.secrets.length === 0 && (
                  <span className="lane-empty">No Client Secrets issued.</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RevisionLog({
  events,
  limit,
  selfId,
}: {
  events: AuditEvent[] | null;
  limit?: number;
  selfId?: string;
}): React.JSX.Element {
  if (events === null) return <p className="loading-notice">Reading revision log…</p>;
  const rows = limit ? events.slice(0, limit) : events;
  if (rows.length === 0) {
    return <p className="empty-note">No revisions recorded yet.</p>;
  }
  return (
    <div className="rev-log">
      <div className="rev-row head">
        <span>Rev</span>
        <span>When</span>
        <span>Action</span>
        <span>Actor</span>
      </div>
      {rows.map((event, i) => (
        <div className="rev-row" key={event.id}>
          <span className="rev-no">{String(events.length - i).padStart(3, '0')}</span>
          <span className="rev-when">{stamp(event.occurredAt)}</span>
          <span className="rev-action">{event.kind}</span>
          <span className="rev-actor" title={event.actor}>
            {actorLabel(event.actor, selfId)}
          </span>
        </div>
      ))}
    </div>
  );
}

function DirectoryView({ events }: { events: AuditEvent[] | null }): React.JSX.Element {
  if (events === null) return <p className="loading-notice">Reading identities…</p>;
  const raw = events
    .filter(
      (event) =>
        event.kind === 'identity.verification.completed' ||
        event.kind === 'identity.reservation.created',
    )
    .map((event) => ({
      email: stringField(event, 'email') ?? 'unknown',
      verified: event.kind === 'identity.verification.completed',
      at: event.occurredAt,
    }));
  const directory = uniqueBy(
    [...raw].sort((a, b) => Number(b.verified) - Number(a.verified)),
    (entry) => entry.email,
  );
  if (directory.length === 0) {
    return <p className="empty-note">No identities recorded yet.</p>;
  }
  return (
    <div className="rev-log">
      <div className="rev-row head">
        <span>Rev</span>
        <span>When</span>
        <span>Identity</span>
        <span>State</span>
      </div>
      {directory.map((identity, i) => (
        <div className="rev-row" key={identity.email}>
          <span className="rev-no">{String(i + 1).padStart(3, '0')}</span>
          <span className="rev-when">{identity.at.slice(0, 10)}</span>
          <span className="rev-action">{identity.email}</span>
          <span className="rev-actor">{identity.verified ? 'verified' : 'reserved'}</span>
        </div>
      ))}
    </div>
  );
}

function Overview({
  session,
  events,
  applications,
}: {
  session: AdministratorSession;
  events: AuditEvent[] | null;
  applications: Application[];
}): React.JSX.Element {
  return (
    <div>
      <SignalBand events={events} />
      <Schematic session={session} applications={applications} events={events ?? []} />
      <div className="section-head">
        <h2>Revision log</h2>
        <span className="section-note">Latest 8</span>
      </div>
      <RevisionLog events={events} limit={8} selfId={session.administratorId} />
    </div>
  );
}

export function DashboardPage(): React.JSX.Element {
  const { session, loading } = useSession();
  const location = useLocation();
  const sheet = sheetFor(location.pathname);
  const events = useAudit(Boolean(session));
  const applications = useApplications(Boolean(session));

  if (loading) return <p className="loading-notice">Checking your session…</p>;

  if (!session) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              IK
            </div>
            <span className="brand-name">IdentiK</span>
          </div>
          <h1>Not signed in</h1>
          <p className="auth-sub">
            This is the administration sheet for an Organization. Sign in as an Administrator to
            open it.
          </p>
          <a className="button" href="/sign-in" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
            Administrator sign-in
          </a>
        </section>
      </main>
    );
  }

  const issued = new Date().toISOString().slice(0, 10);

  return (
    <div className="sheet">
      <header className="titleblock">
        <div className="tb-project">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">
              IK
            </div>
            <span className="brand-name">IdentiK</span>
          </div>
          <div>
            <div className="tb-ref">Organization</div>
            <strong>{session.organizationName}</strong>
          </div>
        </div>
        <dl className="tb-cells">
          <div>
            <dt>Sheet</dt>
            <dd>{sheet.ref}</dd>
          </div>
          <div>
            <dt>Rev</dt>
            <dd>{String(events?.length ?? 0).padStart(3, '0')}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{issued}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>Issued for operation</dd>
          </div>
        </dl>
      </header>

      <div className="sheet-body">
        <nav className="register" aria-label="Sheets">
          <div className="register-brand">
            <span className="register-note">Sheet register</span>
          </div>
          {SHEETS.map((entry) => (
            <NavLink
              key={entry.path}
              to={entry.path}
              end={entry.path === '/'}
              className={({ isActive }) => `register-item${isActive ? ' active' : ''}`}
            >
              <span className="reg-index">{entry.index}</span>
              <span className="reg-label">{entry.label}</span>
            </NavLink>
          ))}
          <div className="register-foot">
            <span className="register-note">Signed in · {session.role}</span>
            <button
              className="button-quiet-link"
              onClick={async () => {
                await adminSignOut();
                window.location.href = '/sign-in';
              }}
            >
              Sign out
            </button>
          </div>
        </nav>

        <main className="sheet-canvas">
          <div className="field-head">
            <h1>{sheet.title}</h1>
            <span className="field-ref">Drawing {sheet.ref}</span>
          </div>
          <Routes>
            <Route
              path="/"
              element={<Overview session={session} events={events} applications={applications} />}
            />
            <Route
              path="/users"
              element={<DirectoryView events={events} />}
            />
            <Route path="/applications" element={<ApplicationsPage />} />
            <Route path="/administrators" element={<AdministratorsPage />} />
            <Route
              path="/audit"
              element={
                <div>
                  <RevisionLog events={events} selfId={session.administratorId} />
                </div>
              }
            />
          </Routes>
        </main>
      </div>
    </div>
  );
}
