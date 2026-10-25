import { BadRequestError } from './errors';

/**
 * Normalizes and validates a phone number into strict E.164 format (e.g. +1234567890).
 */
export function normalizePhoneNumber(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new BadRequestError('Phone number is required and must be a string');
  }

  // Remove whitespace, dashes, parens, dots
  let cleaned = raw.trim().replace(/[\s\-\(\)\.]/g, '');

  if (!cleaned.startsWith('+')) {
    // If user provided raw digits starting with country code without '+', prefix '+'
    cleaned = `+${cleaned}`;
  }

  // E.164 regex: + followed by 1-9 and then 7 to 14 digits (total 8-15 digits)
  const e164Regex = /^\+[1-9]\d{7,14}$/;
  if (!e164Regex.test(cleaned)) {
    throw new BadRequestError(
      `Invalid phone number "${raw}". Must be in valid E.164 format (e.g. +15551234567)`
    );
  }

  return cleaned;
}

/**
 * Normalizes and validates an email address (trims, converts to lowercase, verifies format).
 */
export function normalizeEmail(raw: string): string {
  if (!raw || typeof raw !== 'string') {
    throw new BadRequestError('Email address is required and must be a string');
  }

  const cleaned = raw.trim().toLowerCase();

  // Basic RFC 5322 compatible email regex
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  if (!emailRegex.test(cleaned) || cleaned.length > 254) {
    throw new BadRequestError(`Invalid email address "${raw}"`);
  }

  return cleaned;
}
