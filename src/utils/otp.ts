import crypto from 'crypto';

export type OtpPurpose = 'phone_verification' | 'email_verification';

/**
 * Generates a cryptographically secure 6-digit numeric OTP.
 */
export function generateSecureOtp(): string {
  // Generates integer between 100000 and 999999 inclusive
  return crypto.randomInt(100000, 1000000).toString();
}

/**
 * Generates a cryptographically secure session bearer token.
 */
export function generateSessionToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('hex');
}

/**
 * Computes a SHA-256 hash of a session token for secure database storage.
 */
export function hashSessionToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Computes a keyed HMAC-SHA256 hash of an OTP bound to its purpose and target (phone or email).
 * Storing only keyed hashes prevents database compromise from leaking plaintext OTPs,
 * and binding to purpose+target prevents cross-channel and cross-target code replays.
 */
export function computeOtpHash(
  otp: string,
  purpose: OtpPurpose,
  target: string,
  secret: string
): string {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(`${purpose}:${target}:${otp}`);
  return hmac.digest('hex');
}

/**
 * Verifies an input OTP against the stored keyed hash using constant-time comparison.
 */
export function verifyOtpHash(
  inputOtp: string,
  purpose: OtpPurpose,
  target: string,
  expectedHash: string,
  secret: string
): boolean {
  if (!inputOtp || !expectedHash || !secret) {
    return false;
  }

  const computedHex = computeOtpHash(inputOtp.trim(), purpose, target, secret);
  const expectedBuffer = Buffer.from(expectedHash, 'hex');
  const computedBuffer = Buffer.from(computedHex, 'hex');

  if (expectedBuffer.length !== computedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, computedBuffer);
}
