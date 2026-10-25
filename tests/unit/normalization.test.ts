import { describe, it, expect } from 'vitest';
import { normalizePhoneNumber, normalizeEmail } from '../../src/utils/normalization';
import { BadRequestError } from '../../src/utils/errors';

describe('Normalization Utility', () => {
  describe('normalizePhoneNumber', () => {
    it('normalizes formatted international phone numbers to E.164', () => {
      expect(normalizePhoneNumber('+1 (555) 123-4567')).toBe('+15551234567');
      expect(normalizePhoneNumber('  +44 20 7946 0958 ')).toBe('+442079460958');
      expect(normalizePhoneNumber('+91-98765-43210')).toBe('+919876543210');
    });

    it('adds leading + if valid country code digits provided without +', () => {
      expect(normalizePhoneNumber('15551234567')).toBe('+15551234567');
      expect(normalizePhoneNumber('919876543210')).toBe('+919876543210');
    });

    it('rejects invalid or malformed phone numbers', () => {
      expect(() => normalizePhoneNumber('')).toThrow(BadRequestError);
      expect(() => normalizePhoneNumber('123')).toThrow(BadRequestError); // Too short
      expect(() => normalizePhoneNumber('not-a-number')).toThrow(BadRequestError);
      expect(() => normalizePhoneNumber('+0123456789')).toThrow(BadRequestError); // Country code cannot start with 0
      expect(() => normalizePhoneNumber('+123456789012345678')).toThrow(BadRequestError); // Too long (>15 digits)
    });
  });

  describe('normalizeEmail', () => {
    it('normalizes email addresses to trimmed lowercase', () => {
      expect(normalizeEmail('  Alice.Doe@EXAMPLE.COM ')).toBe('alice.doe@example.com');
      expect(normalizeEmail('USER+tag@sub.domain.org')).toBe('user+tag@sub.domain.org');
    });

    it('rejects invalid email formats', () => {
      expect(() => normalizeEmail('')).toThrow(BadRequestError);
      expect(() => normalizeEmail('plainaddress')).toThrow(BadRequestError);
      expect(() => normalizeEmail('@missinguser.com')).toThrow(BadRequestError);
      expect(() => normalizeEmail('user@')).toThrow(BadRequestError);
      expect(() => normalizeEmail('user @example.com')).toThrow(BadRequestError);
    });
  });
});
