import crypto from 'crypto';

/**
 * AES-256-GCM authenticated encryption for secrets at rest (browser session state).
 * Format: "v1.<iv>.<tag>.<ciphertext>" (base64url). A fresh random 96-bit IV is used per message,
 * and `aad` (e.g. "<userId>:<origin>") binds a ciphertext to its owner so a row copied to another
 * user or site cannot be decrypted.
 */
const VERSION = 'v1';

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

function parseKey(raw: string): Buffer {
  if (!raw) throw new SecretBoxError('Encryption key is not configured');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new SecretBoxError('Encryption key must be 32 bytes, base64 encoded');
  return key;
}

export function encryptSecret(plaintext: string, rawKey: string, aad: string): string {
  const key = parseKey(rawKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(payload: string, rawKey: string, aad: string): string {
  const key = parseKey(rawKey);
  const [version, iv, tag, ciphertext] = payload.split('.');
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new SecretBoxError('Unsupported or malformed ciphertext');
  }
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    // Wrong key, wrong owner (aad) or tampered data: never say which.
    throw new SecretBoxError('Could not decrypt the stored secret');
  }
}

export function generateEncryptionKey(): string {
  return crypto.randomBytes(32).toString('base64');
}
