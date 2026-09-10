import { useEffect, useState } from 'react';
import { fetchResetPasswordInfo, resetPassword } from '../api';

/**
 * The hosted reset page (ADR-0018), reached from the reset link in the
 * mailbox. The token is single-use: the page only checks that it is live
 * before drawing the form; completing the form consumes it, sets the new
 * password, marks the email verified (mailbox proof — ADR-0011), and revokes
 * every Session.
 */
export function ResetPasswordPage(): React.JSX.Element {
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [token, setToken] = useState<string>('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('token') ?? '';
    setToken(value);
    fetchResetPasswordInfo(value || undefined)
      .then((info) => {
        setOrganizationName(info.organizationName);
        setValid(info.valid);
      })
      .catch(() => setValid(false));
  }, []);

  if (valid === null) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">IK</div>
            <span className="brand-name">IdentiK</span>
          </div>
          <p className="loading-notice">Checking…</p>
        </section>
      </main>
    );
  }

  if (done) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">IK</div>
            <span className="brand-name">IdentiK</span>
          </div>
          <h1>Password reset</h1>
          <p className="auth-sub">
            Your password has been changed and your email is verified. You can sign in with your
            new password now.
          </p>
        </section>
      </main>
    );
  }

  if (!valid) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">IK</div>
            <span className="brand-name">IdentiK</span>
          </div>
          <h1>This link is invalid</h1>
          <p className="auth-sub">
            Reset links are single-use and expire. Request a fresh link from the forgot-password
            page and try again.
          </p>
          <a className="button" href="/end-users/forgot-password" style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}>
            Request a new link
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
        <h1>Choose a new password</h1>
        <p className="auth-sub">
          Set a new password{organizationName ? ` for your identity at ${organizationName}` : ''}.
        </p>

        {error && <p className="form-error">{error}</p>}

        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitting(true);
            setError(null);
            try {
              const res = await resetPassword(token, password);
              if (res.status === 200) {
                setDone(true);
              } else {
                setError('This reset link is invalid or has expired. Request a new one.');
              }
            } catch {
              setError('Recovery is unavailable right now. Try again in a moment.');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor="password">New password</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <p className="hint">At least 8 characters. You will use it to sign in.</p>
          </div>
          <button className="button" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Set new password'}
          </button>
        </form>
      </section>
    </main>
  );
}
