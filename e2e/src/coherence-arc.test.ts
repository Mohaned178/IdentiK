import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import * as client from 'openid-client';
import { backendDistFromWorkspaceRoot, Instance, WORKSPACE_ROOT } from './instance';

const BACKEND_DIST = backendDistFromWorkspaceRoot(WORKSPACE_ROOT);

/**
 * Ticket 21 — the coherence arc, the release gate. The spec's demo as one
 * executable black-box story: the Instance bootstraps the default
 * Organization and its first Owner; the Owner invites a Member who sets her
 * own password; the Owner registers Zotac as a Web Application; Mohamed signs
 * up, verifies from captured email, and signs in to Zotac through the
 * standard authorization code + PKCE flow played by a stock off-the-shelf
 * OIDC client library (openid-client) — the zero-SDK promise made executable
 * one final time at full scale. The Member then suspends Mohamed and the
 * cascade is observed (Session dead, rotation refused, introspection verdict
 * flipped, the untracked access token dying within one TTL), anonymizes him,
 * and his freed email immediately becomes a fresh, unlinked Identity with
 * nothing inherited. Finally the audit surface tells the whole story, every
 * action present and attributable.
 *
 * Observation happens only at the two seams — the Instance HTTP surface
 * (including the console-revealed Bootstrap Ceremony token) and captured
 * email. Nothing here inspects storage, token internals, or module structure.
 */

const ORGANIZATION_NAME = 'Acme';
const OWNER = { email: 'ahmed@example.com', password: 'owner password 123', name: 'Ahmed' };
const MEMBER = { email: 'layla@example.com', password: 'layla chosen password 123', name: 'Layla' };
const MOHAMED = { email: 'mohamed@example.com', password: 'end user password 123' };

const ZOTAC_REDIRECT = 'https://zotac.example.com/oidc/callback';
const ACCESS_TOKEN_TTL_MS = 4000;
const ANONYMIZED_SHELL = /deleted identity #/i;

interface AdministratorSignIn {
  administratorId: string;
  organizationId: string;
  role: string;
}

interface ApplicationView {
  id: string;
  clientId: string;
}

interface IdentityListItem {
  id: string;
  email: string;
  emailVerified: boolean;
  state: string;
}

interface EnrollmentView {
  applicationId: string;
  suspended: boolean;
}

interface SessionView {
  id: string;
  device: string | null;
}

interface AuditEventView {
  id: string;
  kind: string;
  actor: string;
  actorName: string | null;
  actorEmail: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

interface IdentityDetail extends IdentityListItem {
  enrollments: EnrollmentView[];
  sessions: SessionView[];
  recentActivity: AuditEventView[];
}

function linkFromBody(body: string): string {
  const match = body.match(/https?:\/\/\S+/);
  if (!match) throw new Error('no link in email body');
  return match[0];
}

function tokenFromLink(link: string): string {
  const token = new URL(link).searchParams.get('token');
  if (!token) throw new Error(`no token in link: ${link}`);
  return token;
}

function cookieFrom(res: Response): string {
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('The coherence arc (release gate)', () => {
  let instance: Instance;
  let ownerCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    // A short access-token TTL is the observation window for honest
    // propagation: the untracked bearer token dies on schedule, not on revoke.
    instance = await Instance.start(BACKEND_DIST, {
      IDENTIK_ACCESS_TOKEN_TTL_MS: String(ACCESS_TOKEN_TTL_MS),
    });
  });

  afterAll(async () => {
    await instance.stop();
  });

  it('runs the whole spec demo green in one pass, over HTTP and captured email only', async () => {
    const adminPost = (path: string, cookie: string, body?: unknown): Promise<Response> =>
      instance.request(path, { method: 'POST', headers: { cookie }, body });

    const identityByEmail = async (email: string): Promise<IdentityListItem> => {
      const res = await instance.request('/api/identities', { headers: { cookie: ownerCookie } });
      expect(res.status).toBe(200);
      const { identities } = (await res.json()) as { identities: IdentityListItem[] };
      const found = identities.find((identity) => identity.email === email);
      if (!found) throw new Error(`no Identity for ${email}`);
      return found;
    };

    const identityFrom = async (res: Response): Promise<IdentityDetail> =>
      ((await res.json()) as { identity: IdentityDetail }).identity;

    const identityDetail = async (identityId: string): Promise<IdentityDetail> => {
      const res = await instance.request(`/api/identities/${identityId}`, {
        headers: { cookie: ownerCookie },
      });
      expect(res.status).toBe(200);
      return identityFrom(res);
    };

    const auditEvents = async (): Promise<AuditEventView[]> => {
      const res = await instance.request('/api/audit', { headers: { cookie: ownerCookie } });
      expect(res.status).toBe(200);
      return ((await res.json()) as { events: AuditEventView[] }).events;
    };

    const signUp = async (endUser: { email: string; password: string }): Promise<void> => {
      const res = await instance.request('/api/end-users/sign-up', {
        method: 'POST',
        body: endUser,
      });
      expect(res.status).toBe(201);
    };

    /** Click the newest verification link for an address (Seam 2 → Seam 1). */
    const verifyFromMailbox = async (email: string): Promise<void> => {
      const mail = (await instance.capturedEmails())
        .filter((entry) => entry.to === email && /verify/i.test(entry.subject))
        .at(-1);
      if (!mail) throw new Error(`no verification mail for ${email}`);
      const verified = await fetch(linkFromBody(mail.body), { redirect: 'manual' });
      expect(verified.status).toBe(302);
    };

    // ---- Phase 1: the Instance bootstraps into the default Organization
    // ---- and its first Owner.
    const ceremony = await instance.request('/api/setup', {
      method: 'POST',
      query: { token: instance.setupToken() },
      body: { organizationName: ORGANIZATION_NAME, ...OWNER },
    });
    expect(ceremony.status).toBe(201);

    const ownerSignIn = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: OWNER.email, password: OWNER.password },
    });
    expect(ownerSignIn.status).toBe(200);
    const owner = (await ownerSignIn.json()) as AdministratorSignIn;
    expect(owner.role).toBe('owner');
    ownerCookie = cookieFrom(ownerSignIn);

    // ---- Phase 2: the Owner invites a Member, who sets her own password.
    const invited = await adminPost('/api/administrators/invitations', ownerCookie, {
      email: MEMBER.email,
      role: 'member',
    });
    expect(invited.status).toBe(201);
    const invitationMail = (await instance.capturedEmails()).find(
      (mail) => mail.to === MEMBER.email && /invit/i.test(mail.subject),
    );
    if (!invitationMail) throw new Error('no invitation mail for the Member');
    const accepted = await instance.request('/api/administrators/invitations/accept', {
      method: 'POST',
      body: { token: tokenFromLink(linkFromBody(invitationMail.body)), ...MEMBER },
    });
    expect(accepted.status).toBe(201);
    const memberId = ((await accepted.json()) as { administratorId: string }).administratorId;

    const memberSignIn = await instance.request('/api/administrators/sign-in', {
      method: 'POST',
      body: { email: MEMBER.email, password: MEMBER.password },
    });
    expect(memberSignIn.status).toBe(200);
    expect(((await memberSignIn.json()) as AdministratorSignIn).role).toBe('member');
    memberCookie = cookieFrom(memberSignIn);

    // ---- Phase 3: the Owner registers Zotac as a confidential Web
    // ---- Application and pins its exact redirect URI.
    const registered = await instance.request('/api/applications', {
      method: 'POST',
      headers: { cookie: ownerCookie },
      body: { name: 'Zotac', type: 'web' },
    });
    expect(registered.status).toBe(201);
    const registration = (await registered.json()) as {
      application: ApplicationView;
      clientSecret: string | null;
    };
    const zotac = registration.application;
    expect(registration.clientSecret).toBeTruthy();

    const redirectAdded = await instance.request(
      `/api/applications/${zotac.id}/redirect-uris`,
      {
        method: 'POST',
        headers: { cookie: ownerCookie },
        body: { uri: ZOTAC_REDIRECT },
      },
    );
    expect(redirectAdded.status).toBe(201);

    // Zotac is played by a stock OIDC client library from here on: discovery
    // over HTTP, then code + PKCE with the confidential client's secret.
    const config = await client.discovery(
      new URL(instance.url),
      zotac.clientId,
      registration.clientSecret!,
      undefined,
      { execute: [client.allowInsecureRequests] },
    );

    const signInToZotac = async (
      email: string,
      password: string,
    ): Promise<{ tokens: client.TokenEndpointResponse & client.TokenEndpointResponseHelpers; ssoCookie: string }> => {
      const verifier = client.randomPKCECodeVerifier();
      const challenge = await client.calculatePKCECodeChallenge(verifier);
      const state = client.randomState();
      const nonce = client.randomNonce();
      const authorizationUrl = client.buildAuthorizationUrl(config, {
        redirect_uri: ZOTAC_REDIRECT,
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        nonce,
      });
      const hostedPath = `${authorizationUrl.pathname}${authorizationUrl.search}`;

      // The hosted page: no Session yet, so the sign-in form is served.
      const page = await instance.request(hostedPath, { redirect: 'manual' });
      expect(page.status).toBe(200);

      // The browser posts the form at the same URL; the platform redirects
      // back to Zotac's registered callback with a single-use code.
      const posted = await instance.request(hostedPath, {
        method: 'POST',
        redirect: 'manual',
        body: { email, password },
      });
      if (posted.status !== 302) {
        throw new Error(`sign-in failed: ${posted.status} ${await posted.text()}`);
      }
      const callbackUrl = new URL(posted.headers.get('location')!);
      const ssoCookie = cookieFrom(posted);
      expect(ssoCookie).toMatch(/^identik_sso_session=/);

      // The library exchanges the code, checks state + nonce, and verifies the
      // ID token's signature against the platform's published JWKS — the
      // zero-proprietary-code assertion, executed.
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: verifier,
        expectedState: state,
        expectedNonce: nonce,
      });
      return { tokens, ssoCookie };
    };

    /** A fresh authorize request carried by an existing SSO cookie. */
    const ssoProbe = async (ssoCookie: string): Promise<Response> => {
      const challenge = await client.calculatePKCECodeChallenge(client.randomPKCECodeVerifier());
      const url = client.buildAuthorizationUrl(config, {
        redirect_uri: ZOTAC_REDIRECT,
        scope: 'openid email profile',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state: client.randomState(),
      });
      return instance.request(`${url.pathname}${url.search}`, {
        redirect: 'manual',
        headers: { cookie: ssoCookie },
      });
    };

    // ---- Phase 4: Mohamed signs up and proves his mailbox.
    await signUp(MOHAMED);
    await verifyFromMailbox(MOHAMED.email);
    const mohamedId = (await identityByEmail(MOHAMED.email)).id;

    // ---- Phase 5: the full standard flow — hosted sign-in, code + PKCE,
    // ---- silent Enrollment, offline JWKS verification, userinfo.
    const firstSignIn = await signInToZotac(MOHAMED.email, MOHAMED.password);
    const claims = firstSignIn.tokens.claims();
    expect(claims).toBeDefined();
    expect(claims!.iss).toBe(instance.url);
    expect(claims!.aud).toBe(zotac.clientId);
    expect(claims!.email).toBe(MOHAMED.email);
    expect(claims!.email_verified).toBe(true);
    const subject = claims!.sub!;
    expect(subject).toBeTruthy();
    expect(firstSignIn.tokens.refresh_token).toBeTruthy();

    // The stock library verified the ID token; the access token verifies
    // offline against JWKS too, and its audience is the platform — never
    // Zotac, whose resource authorization is Zotac's own business.
    const jwks = createRemoteJWKSet(new URL(`${instance.url}/api/oidc/jwks`));
    const offline = await jwtVerify(firstSignIn.tokens.access_token, jwks, {
      issuer: instance.url,
      audience: instance.url,
      typ: 'at+jwt',
    });
    expect(offline.payload.sub).toBe(subject);
    expect(offline.payload.client_id).toBe(zotac.clientId);

    const userinfo = (await client.fetchUserInfo(
      config,
      firstSignIn.tokens.access_token,
      subject,
    )) as unknown as Record<string, unknown>;
    expect(userinfo).toMatchObject({ email: MOHAMED.email, email_verified: true });

    // Silent Enrollment: first authentication through Zotac enrolled Mohamed
    // and created the platform Session that parents his tokens.
    const enrolled = await identityDetail(mohamedId);
    expect(enrolled).toMatchObject({ email: MOHAMED.email, state: 'active' });
    expect(enrolled.enrollments.filter((entry) => entry.applicationId === zotac.id)).toHaveLength(1);
    expect(enrolled.sessions).toHaveLength(1);

    const liveVerdict = await client.tokenIntrospection(config, firstSignIn.tokens.access_token);
    expect(liveVerdict.active).toBe(true);

    // Refresh rotation works while the Session lives — the lineage is real
    // before the suspension cuts it, and the rotated token is the freshest
    // thing the cascade has to kill.
    const rotated = await client.refreshTokenGrant(config, firstSignIn.tokens.refresh_token!);
    expect(rotated.access_token).not.toBe(firstSignIn.tokens.access_token);
    expect(rotated.refresh_token).not.toBe(firstSignIn.tokens.refresh_token);

    // ---- Phase 6: the Member suspends Mohamed; the cascade is the story.
    const suspended = await adminPost(`/api/identities/${mohamedId}/suspend`, memberCookie);
    expect(suspended.status).toBe(200);
    expect((await identityFrom(suspended)).state).toBe('suspended');

    // The introspection verdict flips immediately: the platform checks live
    // Identity state at ask-time.
    expect((await client.tokenIntrospection(config, rotated.access_token)).active).toBe(false);

    // Rotation is refused: the Session whose authentication minted the
    // lineage is dead, and its descendant refresh tokens went with it.
    await expect(client.refreshTokenGrant(config, rotated.refresh_token!)).rejects.toThrow();

    // The SSO cookie no longer resolves: the same browser gets the sign-in
    // page again instead of a code, and the device list is empty.
    const deadCookie = await ssoProbe(firstSignIn.ssoCookie);
    expect(deadCookie.status).toBe(200);
    expect((await deadCookie.json()) as Record<string, unknown>).toHaveProperty('request');
    expect((await identityDetail(mohamedId)).sessions).toEqual([]);

    // Access tokens are deliberately untracked: the bearer credential is still
    // cryptographically valid, and dies on schedule rather than on command.
    await expect(
      jwtVerify(rotated.access_token, jwks, { issuer: instance.url, typ: 'at+jwt' }),
    ).resolves.toBeTruthy();

    const issuedTtlSeconds =
      typeof rotated.expires_in === 'number' ? rotated.expires_in : ACCESS_TOKEN_TTL_MS / 1000;
    await sleep((issuedTtlSeconds + 1) * 1000);
    await expect(
      jwtVerify(rotated.access_token, jwks, { issuer: instance.url, typ: 'at+jwt' }),
    ).rejects.toMatchObject({ code: 'ERR_JWT_EXPIRED' });

    // ---- Phase 7: the Member anonymizes Mohamed — deletion as destruction.
    const anonymized = await adminPost(`/api/identities/${mohamedId}/anonymize`, memberCookie, {
      confirm: true,
    });
    expect(anonymized.status).toBe(200);
    const shell = await identityFrom(anonymized);
    expect(shell.state).toBe('anonymized');
    expect(shell.email).not.toBe(MOHAMED.email);
    expect(shell.email).toMatch(ANONYMIZED_SHELL);
    expect(shell.enrollments).toEqual([]);
    expect(shell.sessions).toEqual([]);

    // ---- Phase 8: the freed email becomes a fresh, unlinked Identity that
    // ---- inherits nothing — not a Session, not an Enrollment, not history.
    await signUp(MOHAMED);
    await verifyFromMailbox(MOHAMED.email);
    const rebornId = (await identityByEmail(MOHAMED.email)).id;
    expect(rebornId).not.toBe(mohamedId);

    const rebornBeforeAuth = await identityDetail(rebornId);
    expect(rebornBeforeAuth).toMatchObject({ email: MOHAMED.email, state: 'active' });
    expect(rebornBeforeAuth.enrollments).toEqual([]);
    expect(rebornBeforeAuth.sessions).toEqual([]);
    expect(
      rebornBeforeAuth.recentActivity.every((event) => event.detail.identityId !== mohamedId),
    ).toBe(true);

    // The old browser context and credential lineage stay dead.
    const stillDeadCookie = await ssoProbe(firstSignIn.ssoCookie);
    expect((await stillDeadCookie.json()) as Record<string, unknown>).toHaveProperty('request');
    await expect(client.refreshTokenGrant(config, rotated.refresh_token!)).rejects.toThrow();

    // The reborn Identity authenticates as a different subject and earns its
    // own Session and Enrollment.
    const reborn = await signInToZotac(MOHAMED.email, MOHAMED.password);
    expect(reborn.tokens.claims()!.sub).not.toBe(subject);
    const rebornAfterAuth = await identityDetail(rebornId);
    expect(rebornAfterAuth.enrollments).toHaveLength(1);
    expect(rebornAfterAuth.sessions).toHaveLength(1);

    // ---- Phase 9: the audit surface tells the whole story, every action
    // ---- present and attributable.
    const events = await auditEvents();

    for (const kind of [
      'bootstrap.completed',
      'administrator.invitation.issued',
      'administrator.invitation.accepted',
      'application.registered',
      'client_secret.generated',
      'redirect_uri.added',
      'identity.reservation.created',
      'identity.verification.completed',
      'enrollment.created',
      'identity.suspended',
      'identity.sessions.revoked',
      'session.revoked',
      'identity.anonymized',
    ]) {
      expect(events.some((event) => event.kind === kind), `audit is missing ${kind}`).toBe(true);
    }

    const bootstrap = events.find((event) => event.kind === 'bootstrap.completed')!;
    expect(bootstrap.actor).toBe('instance');
    expect(bootstrap.actorName).toBeNull();

    const invitationIssued = events.find(
      (event) => event.kind === 'administrator.invitation.issued',
    )!;
    expect(invitationIssued.actor).toBe(owner.administratorId);
    expect(invitationIssued.actorName).toBe(OWNER.name);
    expect(invitationIssued.actorEmail).toBe(OWNER.email);

    const invitationAccepted = events.find(
      (event) => event.kind === 'administrator.invitation.accepted',
    )!;
    expect(invitationAccepted.actor).toBe(memberId);
    expect(invitationAccepted.actorName).toBe(MEMBER.name);
    expect(invitationAccepted.actorEmail).toBe(MEMBER.email);

    const zotacRegistered = events.find(
      (event) =>
        event.kind === 'application.registered' && event.detail.applicationId === zotac.id,
    )!;
    expect(zotacRegistered).toBeDefined();
    expect(zotacRegistered.actor).toBe(owner.administratorId);

    const secretGenerated = events.find(
      (event) =>
        event.kind === 'client_secret.generated' && event.detail.applicationId === zotac.id,
    )!;
    expect(secretGenerated).toBeDefined();
    expect(secretGenerated.actor).toBe(owner.administratorId);

    const redirectEvent = events.find(
      (event) => event.kind === 'redirect_uri.added' && event.detail.applicationId === zotac.id,
    )!;
    expect(redirectEvent.actor).toBe(owner.administratorId);
    expect(redirectEvent.detail.uri).toBe(ZOTAC_REDIRECT);

    // The End User's own actions are attributed to the End-User population,
    // never to an Administrator session.
    for (const kind of [
      'identity.reservation.created',
      'identity.verification.completed',
      'enrollment.created',
    ]) {
      const kindEvents = events.filter((event) => event.kind === kind);
      expect(kindEvents.length, kind).toBeGreaterThan(0);
      expect(kindEvents.every((event) => event.actor === 'end-user'), kind).toBe(true);
    }
    for (const identityId of [mohamedId, rebornId]) {
      const enrollment = events.find(
        (event) => event.kind === 'enrollment.created' && event.detail.identityId === identityId,
      );
      expect(enrollment, `enrollment.created for ${identityId}`).toBeDefined();
      expect(enrollment!.detail.applicationId).toBe(zotac.id);
    }

    const suspensionEvent = events.find(
      (event) => event.kind === 'identity.suspended' && event.detail.identityId === mohamedId,
    )!;
    expect(suspensionEvent).toBeDefined();
    expect(suspensionEvent.actor).toBe(memberId);
    expect(suspensionEvent.actorName).toBe(MEMBER.name);

    // The suspension's device cascade: each death, plus the collection action
    // itself, attributed to the Member who pulled the lever.
    const sessionDeaths = events.filter(
      (event) => event.kind === 'session.revoked' && event.detail.identityId === mohamedId,
    );
    expect(sessionDeaths.length).toBeGreaterThanOrEqual(1);
    expect(sessionDeaths.every((event) => event.actor === memberId)).toBe(true);
    expect(sessionDeaths.every((event) => event.detail.reason === 'suspension')).toBe(true);
    const sessionCollection = events.find(
      (event) =>
        event.kind === 'identity.sessions.revoked' &&
        event.detail.identityId === mohamedId &&
        event.detail.reason === 'suspension',
    )!;
    expect(sessionCollection).toBeDefined();
    expect(sessionCollection.actor).toBe(memberId);
    expect(sessionCollection.detail.count).toBe(1);

    const anonymizationEvent = events.find(
      (event) => event.kind === 'identity.anonymized' && event.detail.identityId === mohamedId,
    )!;
    expect(anonymizationEvent).toBeDefined();
    expect(anonymizationEvent.actor).toBe(memberId);
    expect(anonymizationEvent.actorName).toBe(MEMBER.name);
    expect(String(anonymizationEvent.detail.pseudonym)).toMatch(ANONYMIZED_SHELL);

    // The destroyed trail survives only pseudonymously: no event of the old
    // Identity names the freed address.
    for (const event of events.filter((entry) => entry.detail.identityId === mohamedId)) {
      expect(JSON.stringify(event.detail), `${event.kind} still names the destroyed email`).not.toContain(
        MOHAMED.email,
      );
    }
    expect(suspensionEvent.detail.email).toMatch(ANONYMIZED_SHELL);

    // The reborn Identity's own trail is fresh and ends with its Enrollment.
    expect(
      events.some(
        (event) => event.kind === 'identity.verification.completed' && event.detail.identityId === rebornId,
      ),
    ).toBe(true);
    expect(
      events.some(
        (event) =>
          event.kind === 'enrollment.created' &&
          event.detail.identityId === rebornId &&
          event.detail.applicationId === zotac.id,
      ),
    ).toBe(true);
    const reservations = events.filter((event) => event.kind === 'identity.reservation.created');
    expect(reservations).toHaveLength(2);
    expect(reservations.filter((event) => event.detail.email === MOHAMED.email)).toHaveLength(1);
    expect(
      reservations.some((event) => String(event.detail.email).match(ANONYMIZED_SHELL)),
    ).toBe(true);
  });
});
