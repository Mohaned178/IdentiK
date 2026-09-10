import { useEffect, useState } from 'react';
import { fetchVerificationOutcome, type VerificationOutcome } from '../api';

/**
 * The hosted result page for a verification click: the outcome travels in the
 * query string, placed by the verification redirect. Verified means the
 * Identity is active; invalid covers expired, already-used, and garbage
 * tokens — without saying which, so the link is not an oracle.
 */
export function VerifyEmailResultPage(): React.JSX.Element {
  const [outcome, setOutcome] = useState<VerificationOutcome | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    fetchVerificationOutcome(params.get('outcome') ?? undefined)
      .then(setOutcome)
      .catch(() => setOutcome(null))
      .finally(() => setLoaded(true));
  }, []);

  return (
    <main className="auth-shell">
      <section className="auth-card">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">IK</div>
          <span className="brand-name">IdentiK</span>
        </div>
        {!loaded ? (
          <p className="loading-notice">Checking…</p>
        ) : outcome === 'verified' ? (
          <>
            <h1>Email verified</h1>
            <p className="auth-sub">
              Your email is verified and your identity is active. You can sign in to your
              Organization's applications with it now.
            </p>
          </>
        ) : (
          <>
            <h1>This link is invalid</h1>
            <p className="auth-sub">
              The verification link is single-use and expires. Sign up again to receive a fresh
              one, or check whether you already verified this email.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
