/**
 * The one way an email becomes the handle the platform looks up and keys
 * throttling by: trimmed and lower-cased. Sharing it keeps the Identity
 * lookup and the rate limiter's Identity dimension from drifting apart.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
