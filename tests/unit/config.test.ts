import { describe, it, expect, beforeEach } from 'vitest';
import { validateEnv, getSafeConfig, resetConfigForTesting } from '../../src/config/env';

describe('Environment Configuration Validation', () => {
  beforeEach(() => {
    resetConfigForTesting();
  });

  it('validates a complete valid environment configuration', () => {
    const validEnv = {
      NODE_ENV: 'development',
      PORT: '3000',
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgresql://user:pass@localhost:5432/testdb',
      DATABASE_POOL_MIN: '2',
      DATABASE_POOL_MAX: '10',
      WHATSAPP_VERIFY_TOKEN: 'verify_token_123',
      WHATSAPP_APP_SECRET: 'meta_secret_abc123',
      WHATSAPP_ACCESS_TOKEN: 'access_token_xyz',
      WHATSAPP_PHONE_NUMBER_ID: '987654321',
      AI_PROVIDER: 'stub',
      AI_MODEL: 'gpt-4o-mini',
    };

    const config = validateEnv(validEnv);
    expect(config.NODE_ENV).toBe('development');
    expect(config.PORT).toBe(3000);
    expect(config.DATABASE_POOL_MIN).toBe(2);
    expect(config.DATABASE_POOL_MAX).toBe(10);
    expect(config.WHATSAPP_VERIFY_TOKEN).toBe('verify_token_123');
  });

  it('fails when required WhatsApp credentials are missing', () => {
    const invalidEnv = {
      NODE_ENV: 'development',
      PORT: '3000',
      // Missing WHATSAPP_VERIFY_TOKEN, WHATSAPP_APP_SECRET, etc.
    };

    expect(() => validateEnv(invalidEnv)).toThrow(/Environment validation failed/);
  });

  it('strictly rejects placeholder credentials in production mode', () => {
    const prodWithPlaceholder = {
      NODE_ENV: 'production',
      PORT: '3000',
      DATABASE_URL: 'postgresql://postgres:secret@db:5432/prod_db',
      WHATSAPP_VERIFY_TOKEN: 'real_verify_token',
      WHATSAPP_APP_SECRET: 'your_meta_app_secret_here', // Placeholder!
      WHATSAPP_ACCESS_TOKEN: 'real_token',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
      AI_PROVIDER: 'stub',
    };

    expect(() => validateEnv(prodWithPlaceholder)).toThrow(
      /Production environment requires a real WHATSAPP_APP_SECRET/
    );
  });

  it('strictly requires valid AI_API_KEY in production when provider is openai', () => {
    const prodMissingAiKey = {
      NODE_ENV: 'production',
      PORT: '3000',
      DATABASE_URL: 'postgresql://postgres:secret@db:5432/prod_db',
      WHATSAPP_VERIFY_TOKEN: 'real_verify_token',
      WHATSAPP_APP_SECRET: 'real_app_secret_abc',
      WHATSAPP_ACCESS_TOKEN: 'real_access_token',
      WHATSAPP_PHONE_NUMBER_ID: '123456789',
      AI_PROVIDER: 'openai',
      AI_API_KEY: '', // Missing!
    };

    expect(() => validateEnv(prodMissingAiKey)).toThrow(
      /Production environment requires a valid AI_API_KEY/
    );
  });

  it('safely redacts secrets in getSafeConfig', () => {
    const config = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://superadmin:supersecret@db:5432/mydb',
      WHATSAPP_VERIFY_TOKEN: 'my_secret_verify',
      WHATSAPP_APP_SECRET: 'my_secret_app',
      WHATSAPP_ACCESS_TOKEN: 'my_secret_access',
      WHATSAPP_PHONE_NUMBER_ID: '12345',
      AI_API_KEY: 'sk-123456789',
    });

    const safe = getSafeConfig(config);
    expect(safe.DATABASE_URL).toBe('[REDACTED_DB_URL]');
    expect(safe.WHATSAPP_VERIFY_TOKEN).toBe('[REDACTED_VERIFY_TOKEN]');
    expect(safe.WHATSAPP_APP_SECRET).toBe('[REDACTED_SECRET]');
    expect(safe.WHATSAPP_ACCESS_TOKEN).toBe('[REDACTED_TOKEN]');
    expect(safe.AI_API_KEY).toBe('[REDACTED_AI_KEY]');
    expect(safe.PORT).toBe(3000);
  });
});
