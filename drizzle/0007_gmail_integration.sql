-- Gmail OAuth connections: one row per user's linked Google account.
-- Stores only encrypted refresh tokens and metadata; access tokens are transient.
CREATE TABLE IF NOT EXISTS "gmail_connections" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "google_email" varchar(255) NOT NULL,
  "scopes" text NOT NULL,
  "encrypted_refresh_token" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'connected',
  "last_used_at" timestamp with time zone,
  "token_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "gmail_connections_status_chk" CHECK ("status" IN ('connected', 'expired', 'revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "gmail_connections_user_email_idx" ON "gmail_connections" ("user_id", "google_email");
CREATE INDEX IF NOT EXISTS "gmail_connections_user_status_idx" ON "gmail_connections" ("user_id", "status");

-- Gmail OAuth state parameters for CSRF protection.
CREATE TABLE IF NOT EXISTS "gmail_oauth_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "state" varchar(128) NOT NULL,
  "code_verifier" varchar(128) NOT NULL,
  "requested_scopes" text NOT NULL,
  "redirect_uri" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "gmail_oauth_states_state_idx" ON "gmail_oauth_states" ("state");
CREATE INDEX IF NOT EXISTS "gmail_oauth_states_expires_idx" ON "gmail_oauth_states" ("expires_at");

-- Email send log for duplicate-send protection: each send is recorded with an idempotency key.
CREATE TABLE IF NOT EXISTS "gmail_send_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "connection_id" uuid NOT NULL REFERENCES "gmail_connections" ("id") ON DELETE CASCADE,
  "idempotency_key" varchar(128) NOT NULL,
  "message_id" varchar(255),
  "thread_id" varchar(255),
  "recipient" text NOT NULL,
  "subject" text NOT NULL,
  "status" varchar(16) NOT NULL DEFAULT 'sent',
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS "gmail_send_log_user_idempotency_idx" ON "gmail_send_log" ("user_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "gmail_send_log_connection_idx" ON "gmail_send_log" ("connection_id");
