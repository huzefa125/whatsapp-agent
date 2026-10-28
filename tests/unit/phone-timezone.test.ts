import { describe, it, expect } from 'vitest';
import { suggestTimezoneFromPhone } from '../../src/services/reminders/phone-timezone';

describe('suggestTimezoneFromPhone', () => {
  it('suggests a zone for single-timezone countries', () => {
    expect(suggestTimezoneFromPhone('+919876543210')).toBe('Asia/Kolkata');
    expect(suggestTimezoneFromPhone('+447700900123')).toBe('Europe/London');
    expect(suggestTimezoneFromPhone('+971501234567')).toBe('Asia/Dubai');
  });
  it('refuses to guess for multi-timezone countries', () => {
    for (const n of ['+14155550123', '+79161234567', '+5511912345678', '+61412345678', '+5215512345678']) {
      expect(suggestTimezoneFromPhone(n)).toBeNull();
    }
  });
});
