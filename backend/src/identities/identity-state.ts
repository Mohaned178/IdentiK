/**
 * The Administrator-facing authentication state of an Identity (ADR-0008):
 * one derived label from the state columns an Administrator may see. The
 * precedence is deliberate — suspension is the strongest statement, then an
 * unverified reservation (inert until mailbox proof), then a usable Identity.
 */
export type IdentityState = 'active' | 'unverified' | 'suspended';

export function identityState(input: {
  emailVerified: boolean;
  suspended: boolean;
}): IdentityState {
  if (input.suspended) return 'suspended';
  return input.emailVerified ? 'active' : 'unverified';
}
