import { useEffect, useState } from 'react';
import { endUserSignUp, fetchSignUpInfo } from '../api';

/**
 * The hosted End-User sign-up page (ADR-0018): the Organization's own page,
 * carrying its name (full per-Organization branding arrives with ticket 18).
 * Whatever happens — accepted or refused — the visitor sees the same
 * "check your mailbox" outcome; the accepted/refused distinction travels to
 * the mailbox, never the page (ADR-0005).
 */
export function EndUserSignUpPage(): React.JSX.Element {
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetchSignUpInfo()
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
            If {email} can sign up at {organizationName ?? 'this Organization'}, a message with
            the next step is on its way. Already have an identity here? Sign in instead.
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
        <h1>Sign up</h1>
        <p className="auth-sub">
          Create your identity{organizationName ? ` at ${organizationName}` : ''} with your email
          and a password. We will send a verification link before it becomes active.
        </p>

        {error && <p className="form-error">{error}</p>}

        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitting(true);
            setError(null);
            try {
              const res = await endUserSignUp({ email, password });
              if (res.status === 201) {
                setDone(true);
              } else {
                setError('Sign-up was refused. Check the form and try again.');
              }
            } catch {
              setError('Sign-up is unavailable right now. Try again in a moment.');
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
          <div className="field">
            <label htmlFor="password">Password</label>
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
            {submitting ? 'Creating…' : 'Sign up'}
          </button>
        </form>
      </section>
    </main>
  );
}
