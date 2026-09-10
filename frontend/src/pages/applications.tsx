import { useCallback, useEffect, useState } from 'react';
import {
  fetchApplications,
  generateClientSecret,
  registerApplication,
  revokeClientSecret,
  useSession,
  type Application,
  type ApplicationType,
} from '../api';

/**
 * Application registration and Client credential lifecycle (ADR-0009,
 * ADR-0010), through the Management API — the dashboard is its first client
 * (ADR-0019). A Web Application's Client Secret is shown exactly once at
 * generation and can never be read back; a SPA/Mobile Application is a public
 * client and is never offered a secret. Secret actions are Owner-only.
 */
function ApplicationCard({
  application,
  isOwner,
  onChanged,
}: {
  application: Application;
  isOwner: boolean;
  onChanged: () => void;
}): React.JSX.Element {
  const [label, setLabel] = useState('');
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isPublic = application.type === 'spa';

  async function generate(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await generateClientSecret(application.id, label);
      if (res.status === 201) {
        const body = (await res.json()) as { clientSecret: string };
        setOneTimeSecret(body.clientSecret);
        setLabel('');
        onChanged();
      } else {
        setError('The Client Secret could not be generated.');
      }
    } catch {
      setError('The Client Secret could not be generated right now.');
    } finally {
      setBusy(false);
    }
  }

  async function revoke(secretId: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await revokeClientSecret(application.id, secretId);
      if (res.status === 200) onChanged();
      else setError('The Client Secret could not be revoked.');
    } catch {
      setError('The Client Secret could not be revoked right now.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="application-card">
      <header className="application-head">
        <h3>{application.name}</h3>
        <span className="application-type">
          {isPublic ? 'SPA/Mobile (public client)' : 'Web Application (confidential client)'}
        </span>
      </header>

      <div className="field">
        <label>Client ID</label>
        <code className="client-id">{application.clientId}</code>
        <p className="hint">Public and permanent. Safe to put in URLs and logs; never rotated.</p>
      </div>

      {error && <p className="form-error">{error}</p>}

      {oneTimeSecret && (
        <p className="form-success">
          Copy this Client Secret now — it will never be shown again:
          <br />
          <code className="client-secret">{oneTimeSecret}</code>
        </p>
      )}

      {isPublic ? (
        <p className="empty-note">
          A SPA/Mobile Application authenticates with PKCE and is never issued a Client Secret.
        </p>
      ) : (
        <>
          <h4>Client Secrets</h4>
          {application.secrets.length === 0 ? (
            <p className="empty-note">No Client Secrets yet.</p>
          ) : (
            <ul className="secret-list">
              {application.secrets.map((secret) => (
                <li key={secret.id}>
                  <span className="audit-kind">{secret.label}</span>
                  <span className="audit-when">
                    {secret.revokedAt
                      ? `revoked ${new Date(secret.revokedAt).toLocaleString()}`
                      : `active since ${new Date(secret.createdAt).toLocaleString()}`}
                  </span>
                  {isOwner && !secret.revokedAt && (
                    <button className="button button-quiet" disabled={busy} onClick={() => revoke(secret.id)}>
                      Revoke
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}

          {isOwner ? (
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                void generate();
              }}
            >
              <div className="field">
                <label htmlFor={`label-${application.id}`}>New secret label</label>
                <input
                  id={`label-${application.id}`}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="e.g. rotation-2026"
                  required
                />
              </div>
              <button className="button" type="submit" disabled={busy || label.trim() === ''}>
                Generate secret
              </button>
            </form>
          ) : (
            <p className="empty-note">Managing Client Secrets is reserved to Owners.</p>
          )}
        </>
      )}
    </section>
  );
}

export function ApplicationsPage(): React.JSX.Element {
  const { session, loading } = useSession();
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [name, setName] = useState('');
  const [type, setType] = useState<ApplicationType>('web');
  const [oneTimeSecret, setOneTimeSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isOwner = session?.role === 'owner';

  const refresh = useCallback(() => {
    fetchApplications()
      .then(setApplications)
      .catch(() => setApplications([]));
  }, []);

  useEffect(() => {
    if (session) refresh();
  }, [session, refresh]);

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
      <h2>Register an Application</h2>
      <p className="auth-sub">
        A Web Application is a confidential client and receives a Client Secret. A SPA/Mobile
        Application is a public client and never does.
      </p>

      {error && <p className="form-error">{error}</p>}
      {oneTimeSecret && (
        <p className="form-success">
          Copy this Client Secret now — it will never be shown again:
          <br />
          <code className="client-secret">{oneTimeSecret}</code>
        </p>
      )}

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(null);
          setOneTimeSecret(null);
          try {
            const res = await registerApplication({ name, type });
            if (res.status === 201) {
              const body = (await res.json()) as { clientSecret: string | null };
              setOneTimeSecret(body.clientSecret ?? null);
              setName('');
              refresh();
            } else if (res.status === 403) {
              setError('Registering a Web Application is reserved to Owners.');
            } else {
              setError('The Application could not be registered. Check the form and try again.');
            }
          } catch {
            setError('The Application could not be registered right now.');
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="field">
          <label htmlFor="application-name">Name</label>
          <input
            id="application-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="application-type">Type</label>
          <select
            id="application-type"
            value={type}
            onChange={(e) => setType(e.target.value as ApplicationType)}
          >
            {isOwner && <option value="web">Web Application — confidential client</option>}
            <option value="spa">SPA/Mobile Application — public client</option>
          </select>
        </div>
        <button className="button" type="submit" disabled={busy || name.trim() === ''}>
          {busy ? 'Registering…' : 'Register Application'}
        </button>
      </form>

      <h2>Applications</h2>
      {applications === null ? (
        <p className="loading-notice">Loading Applications…</p>
      ) : applications.length === 0 ? (
        <p className="empty-note">No Applications registered yet.</p>
      ) : (
        applications.map((application) => (
          <ApplicationCard
            key={application.id}
            application={application}
            isOwner={isOwner}
            onChanged={refresh}
          />
        ))
      )}
    </div>
  );
}
