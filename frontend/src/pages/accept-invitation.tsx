import { useEffect, useState } from 'react';
import { acceptInvitation, fetchInvitationInfo, type AdministratorRole } from '../api';

/**
 * The hosted Administrator invitation page (ADR-0021), reached from the
 * invitation link in the mailbox. The link is single-use: the page only checks
 * that it is live before drawing the form. The invitee chooses their own
 * password — the inviter never sets a credential (ADR-0008).
 */
export function AcceptInvitationPage(): React.JSX.Element {
  const [organizationName, setOrganizationName] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [role, setRole] = useState<AdministratorRole | null>(null);
  const [valid, setValid] = useState<boolean | null>(null);
  const [token, setToken] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get('token') ?? '';
    setToken(value);
    fetchInvitationInfo(value || undefined)
      .then((info) => {
        setOrganizationName(info.organizationName);
        setEmail(info.email);
        setRole(info.role);
        setValid(info.valid);
      })
      .catch(() => setValid(false));
  }, []);

  const brand = (
    <div className="brand">
      <div className="brand-mark" aria-hidden="true">IK</div>
      <span className="brand-name">IdentiK</span>
    </div>
  );

  if (valid === null) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          {brand}
          <p className="loading-notice">Checking…</p>
        </section>
      </main>
    );
  }

  if (done) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          {brand}
          <h1>You are all set</h1>
          <p className="auth-sub">
            Your Administrator membership is ready. Sign in with the password you just chose to
            manage {organizationName}.
          </p>
          <a
            className="button"
            href="/sign-in"
            style={{ display: 'block', textAlign: 'center', textDecoration: 'none' }}
          >
            Go to Administrator sign-in
          </a>
        </section>
      </main>
    );
  }

  if (!valid) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          {brand}
          <h1>This invitation is invalid</h1>
          <p className="auth-sub">
            Invitation links are single-use and expire. Ask an Owner of this Organization to send
            you a fresh invitation.
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-shell">
      <section className="auth-card">
        {brand}
        <h1>Set up your Administrator membership</h1>
        <p className="auth-sub">
          {email ? `${email} was invited` : 'You were invited'} to administer{' '}
          {organizationName ?? 'this Organization'}
          {role ? ` as a ${role === 'owner' ? 'Owner' : 'Member'}` : ''}. Choose your own password —
          nobody else sets it.
        </p>

        {error && <p className="form-error">{error}</p>}

        <form
          onSubmit={async (event) => {
            event.preventDefault();
            setSubmitting(true);
            setError(null);
            try {
              const res = await acceptInvitation({ token, name, password });
              if (res.status === 201) {
                setDone(true);
              } else {
                setError('This invitation link is invalid or has expired.');
              }
            } catch {
              setError('Setup is unavailable right now. Try again in a moment.');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" value={email ?? ''} readOnly disabled />
          </div>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input
              id="name"
              name="name"
              type="text"
              autoComplete="name"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
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
            {submitting ? 'Saving…' : 'Create my membership'}
          </button>
        </form>
      </section>
    </main>
  );
}
