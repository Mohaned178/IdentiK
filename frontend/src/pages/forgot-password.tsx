import { useEffect, useState } from 'react';
import { fetchForgotPasswordInfo, forgotPassword } from '../api';

/**
 * The hosted "forgot password" page (ADR-0018). Whatever happens — an
 * Identity exists or not — the visitor sees the same "check your mailbox"
 * outcome; the distinction travels to the mailbox, never the page
 * (ADR-0005/0020).
 */
export function ForgotPasswordPage(): React.JSX.Element {
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetchForgotPasswordInfo()
      .then((info) => setOrganizationName(info.organizationName))
      .catch(() => setOrganizationName(null));
  }, []);

  if (done) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <div className="brand">
            <div className="brand-mark" aria-hidden="true">IK</div>
            <span className="brand-name">IdentiK</span>
          </div>
          <h1>Check your mailbox</h1>
          <p className="auth-sub">
            If an identity exists for {email}, a message with a reset link is on its way. The link
            lets you choose a new password.
          </p>
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
        <h1>Forgot password</h1>
        <p className="auth-sub">
          Enter your email{organizationName ? ` for ${organizationName}` : ''} and we will send a
          link to choose a new password.
        </p>

        {error && <p className="form-error">{error}</p>}

        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitting(true);
            setError(null);
            try {
              const res = await forgotPassword(email);
              if (res.status === 202) {
                setDone(true);
              } else {
                setError('That email does not look right. Check it and try again.');
              }
            } catch {
              setError('Recovery is unavailable right now. Try again in a moment.');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button className="button" type="submit" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      </section>
    </main>
  );
}
