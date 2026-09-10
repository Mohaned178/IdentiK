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
