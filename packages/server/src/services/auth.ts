import { randomBytes, createHash } from 'node:crypto';

/** Generate a cryptographically random token (hex-encoded, 32 bytes = 64 chars). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/** SHA-256 hash of a token (hex-encoded). */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
