import { useEffect, useState } from 'react';
import { completeSetup, fetchSetupStatus, type SetupStatus } from '../api';

interface SetupFormState {
  organizationName: string;
  name: string;
  email: string;
  password: string;
  token: string;
}

export function SetupPage(): React.JSX.Element {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [form, setForm] = useState<SetupFormState>({
    organizationName: '',
    name: '',
    email: '',
    password: '',
    token: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetchSetupStatus()
      .then(setStatus)
      .catch(() => setStatus({ completed: false, available: false }));
  }, []);

  if (status?.completed || done) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">IK</div>
            <span className="brand-name">IdentiK</span>
          </div>
          <h1>Setup is complete</h1>
          <p className="auth-sub">
            This Instance has an Organization and its first Owner. Sign in to the dashboard
            to administer it.
          </p>
          <a className="button" href="/sign-in" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
            Go to sign-in
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">IK</div>
          <span className="brand-name">IdentiK</span>
        </div>
        <h1>Bootstrap this Instance</h1>
        <p className="auth-sub">
          One time, on first boot: create your Organization and its first Owner. Paste the
          setup token printed on the Instance console.
        </p>

        {status && !status.available && !error && (
          <p className="form-error">
            The setup window is not open. Check the Instance console for a fresh token, or
            restart the Instance before it expires.
          </p>
        )}
        {error && <p className="form-error">{error}</p>}

        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitting(true);
            setError(null);
            const res = await completeSetup(form.token, {
              organizationName: form.organizationName,
              email: form.email,
              password: form.password,
              name: form.name,
            });
            setSubmitting(false);
            if (res.status === 201) {
              setDone(true);
            } else if (res.status === 409) {
              setError('Setup already completed on this Instance.');
            } else {
              setError(
                'The ceremony was refused. Verify the setup token from the Instance console and try again.',
              );
            }
          }}
        >
          <div className="field">
            <label htmlFor="token">Setup token</label>
            <input
              id="token"
              name="token"
              autoComplete="one-time-code"
              required
              value={form.token}
              onChange={(e) => setForm({ ...form, token: e.target.value })}
            />
            <p className="hint">Printed once on the Instance console at first boot.</p>
          </div>
          <div className="field">
            <label htmlFor="organizationName">Organization name</label>
            <input
              id="organizationName"
              name="organizationName"
              required
              minLength={2}
              value={form.organizationName}
              onChange={(e) => setForm({ ...form, organizationName: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              name="name"
              autoComplete="name"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="email">Work email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <p className="hint">At least 8 characters. Choose this yourself; it is never shared.</p>
          </div>
          <button className="button" type="submit" disabled={submitting}>
            {submitting ? 'Creating…' : 'Create Organization and Owner'}
          </button>
        </form>
      </section>
    </main>
  );
}
