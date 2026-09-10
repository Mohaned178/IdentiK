import { useState } from 'react';
import { inviteAdministrator, useSession, type AdministratorRole } from '../api';

/**
 * Administrator membership management (ADR-0021). Invitation is Owner-only
 * (ADR-0016); a Member sees the roster is managed by Owners but cannot invite.
 * The Owner supplies an email and a role — never a password: the invitee sets
 * their own credential through the invitation link.
 */
export function AdministratorsPage(): React.JSX.Element {
  const { session, loading } = useSession();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AdministratorRole>('member');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) return <p className="loading-notice">Checking your session…</p>;

  if (!session) {
    return (
      <p className="empty-note">
        You are not signed in. <a href="/sign-in">Sign in as an Administrator</a>.
      </p>
    );
  }

  if (session.role !== 'owner') {
    return (
      <p className="empty-note">
        Inviting Administrators is reserved to Owners. Ask an Owner to add someone.
      </p>
    );
  }

  return (
    <div>
      <div className="section-head">
        <h2>Invite an Administrator</h2>
        <span className="section-note">Owner-only</span>
      </div>
      <p className="auth-sub">
        They will receive an email and choose their own password. You never see or set it.
      </p>

      {error && <p className="form-error">{error}</p>}
      {notice && <p className="form-success">{notice}</p>}

      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setSubmitting(true);
          setError(null);
          setNotice(null);
          try {
            const res = await inviteAdministrator({ email, role });
            if (res.status === 201) {
              setNotice(`Invitation sent to ${email}.`);
              setEmail('');
            } else if (res.status === 409) {
              setError('An administrator with this email already exists.');
            } else {
              setError('The invitation could not be sent. Check the form and try again.');
            }
          } catch {
            setError('The invitation could not be sent right now. Try again in a moment.');
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
          <label htmlFor="role">Administrator Role</label>
          <select
            id="role"
            name="role"
            value={role}
            onChange={(e) => setRole(e.target.value as AdministratorRole)}
          >
            <option value="member">Member — day-to-day administration</option>
            <option value="owner">Owner — everything, including destructive settings</option>
          </select>
        </div>
        <button className="button" type="submit" disabled={submitting}>
          {submitting ? 'Sending…' : 'Send invitation'}
        </button>
      </form>
    </div>
  );
}
