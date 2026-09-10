import {
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

/** A stored hash with this exact shape, used to equalize sign-in timing. */
export const DUMMY_PASSWORD_HASH =
  'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$Zm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFyZm9vYmFy';

/**
 * Password hashing for the platform's own population and (from ticket 03)
 * End Users. Verifiable-only by construction: the hash embeds a random salt
 * and only the derived key is stored; no code path can recover the password.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = (await scrypt(password, salt, KEY_LENGTH)) as Buffer;
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, saltB64, keyB64] = stored.split('$');
  if (algorithm !== 'scrypt' || !saltB64 || !keyB64) return false;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  const actual = (await scrypt(password, salt, expected.length)) as Buffer;
  return timingSafeEqual(actual, expected);
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * Tokens are high-entropy random values, not user-chosen secrets: a plain
 * SHA-256 suffices for stored-token lookup (no stretching needed) and keeps
 * per-request session resolution cheap.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('base64');
}
