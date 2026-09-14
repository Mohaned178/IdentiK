/**
 * The Administrator-facing lifecycle state of an Application (ADR-0007). A
 * Disabled Application is a reversible pause; a Deleted Application is the
 * terminal, anonymized shell whose audit history survives. Precedence is
 * deliberate: deletion cannot be undone, so it wins over the pause.
 *
 * The authorization and token boundaries ask this one predicate for `active`,
 * so the state the dashboard displays and the verdict the boundaries enforce
 * are one computation that cannot drift.
 */
export type ApplicationState = 'active' | 'disabled' | 'deleted';

export function applicationState(input: {
  disabledAt: Date | null;
  deletedAt: Date | null;
}): ApplicationState {
  if (input.deletedAt !== null) return 'deleted';
  if (input.disabledAt !== null) return 'disabled';
  return 'active';
}

/**
 * The pseudonymous shell label a deleted Application's audit history is
 * attributed under (ADR-0007). Derived from the surviving id so it is stable
 * and carries no PII; the Application's real name is scrubbed from event
 * details and replaced by this label.
 */
export function deletedApplicationPseudonym(applicationId: string): string {
  return `deleted application #${applicationId.replace(/-/g, '').slice(0, 4).toLowerCase()}`;
}
