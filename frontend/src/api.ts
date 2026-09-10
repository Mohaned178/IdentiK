import { useEffect, useState } from 'react';

export interface SetupStatus {
  completed: boolean;
  available: boolean;
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const res = await fetch('/api/setup/status');
  if (!res.ok) throw new Error('setup status unavailable');
  return (await res.json()) as SetupStatus;
}

export async function completeSetup(
  token: string,
  body: { organizationName: string; email: string; password: string; name: string },
): Promise<Response> {
  return fetch(`/api/setup?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function adminSignIn(body: { email: string; password: string }): Promise<Response> {
  return fetch('/api/administrators/sign-in', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export interface AdministratorSession {
  membershipId: string;
  role: string;
  organizationId: string;
  organizationName: string;
  administratorId: string;
}

export async function fetchSession(): Promise<AdministratorSession | null> {
  const res = await fetch('/api/administrators/session');
  if (res.status === 401) return null;
  if (!res.ok) throw new Error('session check failed');
  return (await res.json()) as AdministratorSession;
}

export async function adminSignOut(): Promise<void> {
  await fetch('/api/administrators/sign-out', { method: 'POST' });
}

export async function fetchSignUpInfo(): Promise<{ organizationName: string }> {
  const res = await fetch('/api/end-users/sign-up');
  if (!res.ok) throw new Error('sign-up page unavailable');
  return (await res.json()) as { organizationName: string };
}

export async function endUserSignUp(body: { email: string; password: string }): Promise<Response> {
  return fetch('/api/end-users/sign-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export type VerificationOutcome = 'verified' | 'invalid';

export async function fetchVerificationOutcome(
  outcome: string | undefined,
): Promise<VerificationOutcome | null> {
  if (outcome !== 'verified' && outcome !== 'invalid') return null;
  const res = await fetch(`/api/end-users/verify-email/result?outcome=${outcome}`);
  if (!res.ok) return null;
  return outcome;
}

export async function fetchForgotPasswordInfo(): Promise<{ organizationName: string }> {
  const res = await fetch('/api/end-users/forgot-password');
  if (!res.ok) throw new Error('forgot-password page unavailable');
  return (await res.json()) as { organizationName: string };
}

export async function forgotPassword(email: string): Promise<Response> {
  return fetch('/api/end-users/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export interface ResetPasswordInfo {
  organizationName: string;
  valid: boolean;
}

export async function fetchResetPasswordInfo(token: string | undefined): Promise<ResetPasswordInfo> {
  const query = token ? `?token=${encodeURIComponent(token)}` : '';
  const res = await fetch(`/api/end-users/reset-password${query}`);
  if (!res.ok) throw new Error('reset page unavailable');
  return (await res.json()) as ResetPasswordInfo;
}

export async function resetPassword(token: string, password: string): Promise<Response> {
  return fetch('/api/end-users/reset-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, password }),
  });
}

export interface AuditEvent {
  id: string;
  kind: string;
  actor: string;
  detail: unknown;
  occurredAt: string;
}

export function useSession(): { session: AdministratorSession | null; loading: boolean } {
  const [session, setSession] = useState<AdministratorSession | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    fetchSession()
      .then(setSession)
      .catch(() => setSession(null))
      .finally(() => setLoading(false));
  }, []);
  return { session, loading };
}
