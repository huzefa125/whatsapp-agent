import crypto from 'crypto';

/**
 * Validates YCloud's `YCloud-Signature: t=<unix>,s=<hex>` header (HMAC-SHA256 of `${t}.${rawBody}`).
 * Rejects timestamps older than `toleranceSeconds` to limit replay.
 */
export function verifyYCloudSignature(
  rawBody: Buffer | string,
  signatureHeader: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  nowMs: number = Date.now()
): boolean {
  if (!signatureHeader || !secret) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const i = p.indexOf('=');
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    })
  );
  const t = parts['t'];
  const s = parts['s'];
  if (!t || !s || s.length !== 64 || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSeconds) return false;

  try {
    const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody;
    const expected = crypto.createHmac('sha256', secret).update(`${t}.${bodyStr}`).digest();
    const received = Buffer.from(s, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}

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
