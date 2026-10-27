import { describe, it, expect } from 'vitest';
import { validateEnv, type EnvConfig } from '../../src/config/env';
import { resolveProviderKind } from '../../src/services/notifications';

const base = {
  WHATSAPP_VERIFY_TOKEN: 'verify',
  WHATSAPP_APP_SECRET: 'real_app_secret',
  WHATSAPP_ACCESS_TOKEN: 'real_access_token',
  WHATSAPP_PHONE_NUMBER_ID: '1234567890',
  AI_PROVIDER: 'stub',
  AUTH_OTP_HMAC_SECRET: 'a_real_production_secret_that_is_32_chars_or_more',
};

describe('reminder provider configuration', () => {
  it('defaults to the mock provider outside production and the real one in production', () => {
    const dev = validateEnv({ ...base, NODE_ENV: 'development' });
    expect(resolveProviderKind(dev)).toBe('mock');
    const prod = validateEnv({ ...base, NODE_ENV: 'production' });
    expect(resolveProviderKind(prod)).toBe('whatsapp');
  });

  it('refuses to start in production with the mock provider (it would silently deliver nothing)', () => {
    expect(() => validateEnv({ ...base, NODE_ENV: 'production', REMINDER_PROVIDER: 'mock' })).toThrow(/must not use REMINDER_PROVIDER=mock/);
  });

  it('allows an explicit real provider anywhere, and an explicit mock outside production', () => {
    expect(resolveProviderKind(validateEnv({ ...base, NODE_ENV: 'development', REMINDER_PROVIDER: 'whatsapp' }))).toBe('whatsapp');
    expect(resolveProviderKind(validateEnv({ ...base, NODE_ENV: 'test', REMINDER_PROVIDER: 'mock' }))).toBe('mock');
  });

  it('parses worker flags as real booleans ("false" must not be truthy) and rejects bad values', () => {
    const off = validateEnv({ ...base, NODE_ENV: 'development', REMINDER_WORKER_ENABLED: 'false' }) as EnvConfig;
    expect(off.REMINDER_WORKER_ENABLED).toBe(false);
    expect(() => validateEnv({ ...base, NODE_ENV: 'development', REMINDER_WORKER_ENABLED: 'nope' })).toThrow(/Environment validation failed/);
    expect(() => validateEnv({ ...base, NODE_ENV: 'development', REMINDER_MAX_ATTEMPTS: '0' })).toThrow(/Environment validation failed/);
  });

  it('grants reminder permissions to verified users by default', () => {
    const c = validateEnv({ ...base, NODE_ENV: 'development' });
    expect(c.AGENT_DEFAULT_PERMISSIONS.split(',')).toEqual(expect.arrayContaining(['reminders:read', 'reminders:write']));
  });
});
