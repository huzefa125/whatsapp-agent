import crypto from 'crypto';

/**
 * Validates Meta's X-Hub-Signature-256 header using timingSafeEqual to prevent timing attacks.
 *
 * @param rawBody - The raw, unparsed request payload Buffer or string.
 * @param signatureHeader - The raw header string (e.g. "sha256=abcdef123456...").
 * @param appSecret - The Meta App Secret.
 * @returns boolean indicating whether signature matches.
 */
export function verifyMetaSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  appSecret: string
): boolean {
  if (!signatureHeader || !appSecret) {
    return false;
  }

  const prefix = 'sha256=';
  if (!signatureHeader.startsWith(prefix)) {
    return false;
  }

  const signatureHex = signatureHeader.slice(prefix.length).trim();
  if (signatureHex.length !== 64) {
    // SHA256 hex is exactly 64 characters (32 bytes)
    return false;
  }

  try {
    const hmac = crypto.createHmac('sha256', appSecret);
    const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody, 'utf8');
    hmac.update(bodyBuffer);
    const expectedDigest = hmac.digest(); // 32-byte Buffer

    const receivedDigest = Buffer.from(signatureHex, 'hex');
    if (receivedDigest.length !== expectedDigest.length) {
      return false;
    }

    return crypto.timingSafeEqual(expectedDigest, receivedDigest);
  } catch {
    return false;
  }
}
