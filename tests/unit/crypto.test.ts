import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import { verifyMetaSignature } from '../../src/utils/crypto';

describe('Crypto HMAC Signature Verification', () => {
  const secret = 'test_meta_app_secret_32_characters';
  const payload = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });

  function generateSignature(body: string, appSecret: string): string {
    const hmac = crypto.createHmac('sha256', appSecret);
    hmac.update(body);
    return `sha256=${hmac.digest('hex')}`;
  }

  it('verifies a valid signature correctly with string body', () => {
    const signature = generateSignature(payload, secret);
    const isValid = verifyMetaSignature(payload, signature, secret);
    expect(isValid).toBe(true);
  });

  it('verifies a valid signature correctly with Buffer body', () => {
    const bodyBuffer = Buffer.from(payload, 'utf8');
    const signature = generateSignature(payload, secret);
    const isValid = verifyMetaSignature(bodyBuffer, signature, secret);
    expect(isValid).toBe(true);
  });

  it('rejects an invalid signature with tampered body', () => {
    const signature = generateSignature(payload, secret);
    const tamperedPayload = payload + ' ';
    const isValid = verifyMetaSignature(tamperedPayload, signature, secret);
    expect(isValid).toBe(false);
  });

  it('rejects a signature generated with the wrong secret', () => {
    const signature = generateSignature(payload, 'wrong_secret');
    const isValid = verifyMetaSignature(payload, signature, secret);
    expect(isValid).toBe(false);
  });

  it('rejects missing or malformed header formats', () => {
    expect(verifyMetaSignature(payload, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(payload, '', secret)).toBe(false);
    expect(verifyMetaSignature(payload, 'md5=abcdef1234', secret)).toBe(false);
    expect(verifyMetaSignature(payload, 'sha256=too_short', secret)).toBe(false);
    expect(verifyMetaSignature(payload, 'sha256=invalid-hex-chars-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', secret)).toBe(false);
  });
});
