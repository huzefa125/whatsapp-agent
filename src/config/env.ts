import { z } from 'zod';
import dotenv from 'dotenv';

// Load .env file if available
dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // PostgreSQL
  DATABASE_URL: z.string().url().default('postgresql://postgres:postgres@localhost:5432/whatsapp_agent'),
  DATABASE_POOL_MIN: z.coerce.number().int().nonnegative().default(2),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  // WhatsApp Cloud API
  WHATSAPP_VERIFY_TOKEN: z.string().min(1, 'WHATSAPP_VERIFY_TOKEN is required'),
  WHATSAPP_APP_SECRET: z.string().min(1, 'WHATSAPP_APP_SECRET is required'),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1, 'WHATSAPP_ACCESS_TOKEN is required'),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1, 'WHATSAPP_PHONE_NUMBER_ID is required'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),

  // AI Provider
  AI_PROVIDER: z.enum(['openai', 'groq', 'gemini', 'stub']).default('openai'),
  AI_API_KEY: z.string().optional().default(''),
  AI_BASE_URL: z.string().url().optional(),
  AI_MODEL: z.string().default('gpt-4o-mini'),
  AI_MAX_TOKENS: z.coerce.number().int().positive().default(1000),
  AI_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.7),

  // Agent Task Engine
  AGENT_WORKER_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  AGENT_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(2000),
  AGENT_MAX_TOOL_ROUNDS: z.coerce.number().int().min(1).max(20).default(5),
  AGENT_MAX_TOOL_CALLS_PER_ROUND: z.coerce.number().int().min(1).max(10).default(4),
  AGENT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).default(30000),
  AGENT_TASK_TIMEOUT_MS: z.coerce.number().int().min(1000).default(120000),
  AGENT_MAX_TOOL_OUTPUT_CHARS: z.coerce.number().int().min(100).default(4000),
  AGENT_MAX_REQUEST_CHARS: z.coerce.number().int().min(1).default(4000),
  AGENT_MAX_RESPONSE_CHARS: z.coerce.number().int().min(100).default(4000),
  AGENT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  AGENT_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
  AGENT_HISTORY_LIMIT: z.coerce.number().int().min(0).max(100).default(20),
  AGENT_CONFIRMATION_TTL_MINUTES: z.coerce.number().int().min(1).default(30),
  // Comma-separated permissions granted to every fully verified user (no per-user grants yet).
  AGENT_DEFAULT_PERMISSIONS: z.string().default('utility:read'),

  // Security & Rate Limiting
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  CORS_ALLOWED_ORIGINS: z.string().optional().default(''),

  // Dual-Channel Passwordless Authentication
  AUTH_OTP_HMAC_SECRET: z.string().min(32, 'AUTH_OTP_HMAC_SECRET must be at least 32 characters').default('test_auth_otp_hmac_secret_32_characters_long!'),
  AUTH_OTP_EXPIRY_MINUTES: z.coerce.number().int().positive().default(10),
  AUTH_OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(60),
  AUTH_OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  AUTH_SESSION_EXPIRY_DAYS: z.coerce.number().int().positive().default(7),

  // Transactional Email Provider
  EMAIL_PROVIDER: z.enum(['stub', 'smtp']).default('stub'),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().email().optional().default('noreply@instinct-agent.local'),
  SMTP_SECURE: z.coerce.boolean().optional().default(false),
});

export type EnvConfig = z.infer<typeof envSchema>;

/**
 * Validates and returns parsed environment configuration.
 * Throws a formatted descriptive error if required environment variables are missing.
 */
export function validateEnv(customEnv?: Record<string, unknown>): EnvConfig {
  const source = customEnv ?? process.env;
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const errorMessages = result.error.errors
      .map((err) => `  - ${err.path.join('.')}: ${err.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${errorMessages}`);
  }

  const config = result.data;

  // Strict production assertions
  if (config.NODE_ENV === 'production') {
    if (!config.WHATSAPP_APP_SECRET || config.WHATSAPP_APP_SECRET === 'your_meta_app_secret_here') {
      throw new Error('Production environment requires a real WHATSAPP_APP_SECRET');
    }
    if (!config.WHATSAPP_ACCESS_TOKEN || config.WHATSAPP_ACCESS_TOKEN === 'your_system_user_access_token_here') {
      throw new Error('Production environment requires a real WHATSAPP_ACCESS_TOKEN');
    }
    if (config.AI_PROVIDER !== 'stub' && (!config.AI_API_KEY || config.AI_API_KEY.startsWith('your_'))) {
      throw new Error('Production environment requires a valid AI_API_KEY for the chosen AI_PROVIDER');
    }
    if (config.AUTH_OTP_HMAC_SECRET === 'test_auth_otp_hmac_secret_32_characters_long!') {
      throw new Error('Production environment requires a secure, non-default AUTH_OTP_HMAC_SECRET');
    }
    if (config.EMAIL_PROVIDER === 'smtp') {
      if (!config.SMTP_HOST || !config.SMTP_USER || !config.SMTP_PASS) {
        throw new Error('Production environment with EMAIL_PROVIDER=smtp requires SMTP_HOST, SMTP_USER, and SMTP_PASS');
      }
    }
  }

  return config;
}

/**
 * Redacts sensitive tokens from config for safe logging.
 */
export function getSafeConfig(config: EnvConfig): Record<string, unknown> {
  return {
    ...config,
    DATABASE_URL: config.DATABASE_URL ? '[REDACTED_DB_URL]' : undefined,
    WHATSAPP_APP_SECRET: config.WHATSAPP_APP_SECRET ? '[REDACTED_SECRET]' : undefined,
    WHATSAPP_ACCESS_TOKEN: config.WHATSAPP_ACCESS_TOKEN ? '[REDACTED_TOKEN]' : undefined,
    WHATSAPP_VERIFY_TOKEN: config.WHATSAPP_VERIFY_TOKEN ? '[REDACTED_VERIFY_TOKEN]' : undefined,
    AI_API_KEY: config.AI_API_KEY ? '[REDACTED_AI_KEY]' : undefined,
    AUTH_OTP_HMAC_SECRET: config.AUTH_OTP_HMAC_SECRET ? '[REDACTED_AUTH_SECRET]' : undefined,
    SMTP_PASS: config.SMTP_PASS ? '[REDACTED_SMTP_PASS]' : undefined,
  };
}

let cachedConfig: EnvConfig | null = null;

export function getConfig(): EnvConfig {
  if (!cachedConfig) {
    // In test environment, provide deterministic defaults if not provided in process.env
    if (process.env.NODE_ENV === 'test') {
      cachedConfig = validateEnv({
        NODE_ENV: 'test',
        PORT: 3001,
        LOG_LEVEL: 'fatal',
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/whatsapp_test',
        WHATSAPP_VERIFY_TOKEN: 'test_verify_token',
        WHATSAPP_APP_SECRET: 'test_app_secret_32_bytes_meta_mock',
        WHATSAPP_ACCESS_TOKEN: 'test_access_token',
        WHATSAPP_PHONE_NUMBER_ID: '1234567890',
        AI_PROVIDER: 'stub',
        AI_MODEL: 'test-model',
        ...process.env,
      });
    } else {
      cachedConfig = validateEnv();
    }
  }
  return cachedConfig;
}

export function resetConfigForTesting(): void {
  cachedConfig = null;
}
