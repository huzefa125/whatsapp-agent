import { describe, it, expect } from 'vitest';
import {
  generateSecureOtp,
  generateSessionToken,
  hashSessionToken,
  computeOtpHash,
  verifyOtpHash,
} from '../../src/utils/otp';

describe('Cryptographic OTP & Session Utilities', () => {
  const testSecret = 'secret_key_at_least_32_characters_for_hmac_test';

  it('generates a 6-digit numeric OTP', () => {
    for (let i = 0; i < 20; i++) {
      const otp = generateSecureOtp();
      expect(otp).toMatch(/^\d{6}$/);
      const num = parseInt(otp, 10);
      expect(num).toBeGreaterThanOrEqual(100000);
      expect(num).toBeLessThan(1000000);
    }
  });

  it('generates unique session tokens and SHA-256 hashes', () => {
    const token1 = generateSessionToken(32);
    const token2 = generateSessionToken(32);
    expect(token1).not.toBe(token2);
    expect(token1.length).toBe(64); // 32 bytes hex = 64 chars

    const hash1 = hashSessionToken(token1);
    const hash2 = hashSessionToken(token2);
    expect(hash1).not.toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it('computes and verifies keyed OTP hash correctly', () => {
    const otp = '482910';
    const hash = computeOtpHash(otp, 'phone_verification', '+15551234567', testSecret);

    expect(verifyOtpHash(otp, 'phone_verification', '+15551234567', hash, testSecret)).toBe(true);
    expect(verifyOtpHash('999999', 'phone_verification', '+15551234567', hash, testSecret)).toBe(false);
  });

  it('prevents cross-purpose replay (purpose-bound protection)', () => {
    const otp = '482910';
    // Hash created for phone verification
    const phoneHash = computeOtpHash(otp, 'phone_verification', '+15551234567', testSecret);

    // Attempting to verify the same code for email_verification must fail
    expect(verifyOtpHash(otp, 'email_verification', '+15551234567', phoneHash, testSecret)).toBe(false);
  });

  it('prevents cross-target replay (target-bound protection)', () => {
    const otp = '482910';
    // Hash created for Alice (+15551111111)
    const aliceHash = computeOtpHash(otp, 'phone_verification', '+15551111111', testSecret);

    // Attempting to use Alice's code for Bob (+15552222222) must fail
    expect(verifyOtpHash(otp, 'phone_verification', '+15552222222', aliceHash, testSecret)).toBe(false);
  });

  it('fails if HMAC secret differs', () => {
    const otp = '123456';
    const hash = computeOtpHash(otp, 'phone_verification', '+15551234567', testSecret);
    expect(verifyOtpHash(otp, 'phone_verification', '+15551234567', hash, 'different_secret_key_32_characters_long')).toBe(false);
  });
});
