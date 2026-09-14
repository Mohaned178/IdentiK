/**
 * The Administrator-facing authentication state of an Identity (ADR-0008):
 * one derived label from the state columns an Administrator may see. The
 * precedence is deliberate — anonymization is terminal and irreversible
 * (ADR-0007), suspension is the strongest reversible statement, then an
 * unverified reservation (inert until mailbox proof), then a usable Identity.
 */
export type IdentityState = 'active' | 'unverified' | 'suspended' | 'anonymized';

export function identityState(input: {
  emailVerified: boolean;
  suspended: boolean;
  anonymized: boolean;
}): IdentityState {
  if (input.anonymized) return 'anonymized';
  if (input.suspended) return 'suspended';
  return input.emailVerified ? 'active' : 'unverified';
}

/**
 * The single liveness gate every authentication path shares: an Identity is
 * usable only while verified, not suspended, not anonymized (ADR-0006,
 * ADR-0007, ADR-0011). One predicate keeps the gate from drifting between the
 * credential check, token validation, and Session resolution.
 */
export type IdentityGate = 'live' | 'unverified' | 'suspended' | 'anonymized';

export function identityGate(state: {
  emailVerified: boolean;
  suspendedAt: Date | null;
  anonymizedAt: Date | null;
}): IdentityGate {
  if (state.anonymizedAt !== null) return 'anonymized';
  if (state.suspendedAt !== null) return 'suspended';
  if (!state.emailVerified) return 'unverified';
  return 'live';
}

/**
 * The pseudonymous shell label an anonymized Identity is displayed and
 * attributed under (ADR-0007). Derived from the surviving id so it is stable
 * and carries no PII; audit history links to it by identityId, and the old
 * email is scrubbed from event details.
 */
export function anonymizedPseudonym(identityId: string): string {
  return `deleted identity #${identityId.replace(/-/g, '').slice(0, 4).toLowerCase()}`;
}

/**
 * The non-deliverable handle stored on the anonymized shell row. It frees the
 * real email from the Organization's unique handle while remaining an
 * unreachable address: it is not derivable from the pseudonym and never
 * matches a sign-up, so no mailbox-proof flow can revive the shell.
 */
export function anonymizedHandle(identityId: string): string {
  return `deleted-${identityId}@anonymized.invalid`;
}
