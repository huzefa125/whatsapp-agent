import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, boolean, real, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';

/**
 * Users table: stores user identity identified by their WhatsApp phone number and verified email.
 */
export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    phoneNumber: varchar('phone_number', { length: 32 }).notNull().unique(),
    email: varchar('email', { length: 255 }).unique(),
    displayName: varchar('display_name', { length: 255 }),
    phoneVerifiedAt: timestamp('phone_verified_at', { withTimezone: true }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    // IANA timezone (e.g. Asia/Kolkata) used to interpret and display the user's dates and times.
    timezone: varchar('timezone', { length: 64 }),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('users_phone_number_idx').on(table.phoneNumber),
    uniqueIndex('users_email_idx').on(table.email),
  ]
);

/**
 * Auth Flows table: tracks multi-channel authentication progress across phone and email.
 * Ensures partial verification is preserved and enables controlled retries.
 */
export const authFlows = pgTable(
  'auth_flows',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    phoneNumber: varchar('phone_number', { length: 32 }).notNull(),
    email: varchar('email', { length: 255 }).notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    phoneVerified: boolean('phone_verified').default(false).notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    status: varchar('status', { length: 32 }).default('in_progress').notNull(), // 'in_progress' | 'completed' | 'abandoned'
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('auth_flows_phone_email_idx').on(table.phoneNumber, table.email),
    index('auth_flows_status_idx').on(table.status),
  ]
);

/**
 * Auth Challenges table: stores keyed OTP hashes bound to purpose and target.
 * Never stores plaintext OTPs. Enforces expiry, attempt limits, and cooldowns.
 */
export const authChallenges = pgTable(
  'auth_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    authFlowId: uuid('auth_flow_id')
      .notNull()
      .references(() => authFlows.id, { onDelete: 'cascade' }),
    purpose: varchar('purpose', { length: 32 }).notNull(), // 'phone_verification' | 'email_verification'
    target: varchar('target', { length: 255 }).notNull(), // Normalized E.164 phone or lowercase email
    otpHash: varchar('otp_hash', { length: 128 }).notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(), // 'pending' | 'verified' | 'expired' | 'locked'
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastSentAt: timestamp('last_sent_at', { withTimezone: true }).defaultNow().notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('auth_challenges_flow_purpose_idx').on(table.authFlowId, table.purpose),
    index('auth_challenges_target_idx').on(table.target),
  ]
);

/**
 * Sessions table: issued ONLY after both phone and email are verified.
 * Stores cryptographically secure SHA-256 token hashes.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 128 }).notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('sessions_token_hash_idx').on(table.tokenHash),
    index('sessions_user_id_idx').on(table.userId),
  ]
);

/**
 * Conversations table: represents a multi-turn chat session belonging to a user.
 */
export const conversations = pgTable(
  'conversations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: varchar('title', { length: 255 }),
    status: varchar('status', { length: 32 }).default('active').notNull(),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('conversations_user_id_idx').on(table.userId),
  ]
);

/**
 * Messages table: individual turns within a conversation.
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 32 }).notNull(), // 'user' | 'assistant' | 'system'
    content: text('content').notNull(),
    providerMessageId: varchar('provider_message_id', { length: 255 }), // Meta wamid.xxx
    status: varchar('status', { length: 32 }).default('received').notNull(), // 'received' | 'processing' | 'delivered' | 'failed'
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('messages_conversation_id_idx').on(table.conversationId),
    index('messages_user_id_idx').on(table.userId),
    uniqueIndex('messages_provider_message_id_idx').on(table.providerMessageId),
  ]
);

/**
 * Webhook Events table: stores incoming raw webhook payloads for idempotency and audit trail.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    providerEventId: varchar('provider_event_id', { length: 255 }).notNull().unique(),
    eventType: varchar('event_type', { length: 64 }).notNull(), // 'message' | 'status' | 'unsupported' | 'unknown'
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(), // 'pending' | 'processed' | 'failed' | 'ignored'
    errorMessage: text('error_message'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_event_id_idx').on(table.providerEventId),
    index('webhook_events_status_idx').on(table.status),
  ]
);

/**
 * Outbox Jobs table: durable, transactional background tasks for external API calls and retries.
 */
export const outboxJobs = pgTable(
  'outbox_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    jobType: varchar('job_type', { length: 64 }).notNull(),
    payload: jsonb('payload').notNull(),
    status: varchar('status', { length: 32 }).default('pending').notNull(), // 'pending' | 'processing' | 'completed' | 'failed' | 'dead_letter'
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    lastError: text('last_error'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('outbox_jobs_status_next_run_idx').on(table.status, table.nextRunAt),
  ]
);

/**
 * Agent Tasks table: durable unit of work executed by the agent engine.
 * Status transitions are enforced in code (see services/agent/engine/task-state.ts) and guarded
 * in SQL by fenced updates (`locked_by`) so a stale worker cannot overwrite a newer owner.
 */
export const agentTasks = pgTable(
  'agent_tasks',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    conversationId: uuid('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
    taskType: varchar('task_type', { length: 64 }).notNull(),
    input: jsonb('input').notNull(),
    // 'pending' | 'running' | 'awaiting_confirmation' | 'succeeded' | 'failed' | 'cancelled'
    status: varchar('status', { length: 32 }).default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(3).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    // Provider-agnostic model transcript checkpoint (system prompt excluded). Sanitized tool results only.
    transcript: jsonb('transcript'),
    result: jsonb('result'),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    lockedBy: uuid('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    runAfter: timestamp('run_after', { withTimezone: true }).defaultNow().notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    // Where the user is talking to us: 'api' (REST, caller polls) or 'whatsapp' (we push the outcome back).
    channel: varchar('channel', { length: 16 }).default('api').notNull(),
    // WhatsApp reply bookkeeping: `reply_key` is the last outcome already announced to the user
    // (a terminal status, or `awaiting:<callId>`); a task is owed a reply while it differs from the current one.
    replyKey: varchar('reply_key', { length: 96 }),
    replyAttempts: integer('reply_attempts').default(0).notNull(),
    replyNextAt: timestamp('reply_next_at', { withTimezone: true }).defaultNow().notNull(),
    replyLeaseUntil: timestamp('reply_lease_until', { withTimezone: true }),
    replyError: text('reply_error'),
    confirmationExpiresAt: timestamp('confirmation_expires_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('agent_tasks_user_created_idx').on(table.userId, table.createdAt),
    index('agent_tasks_status_run_after_idx').on(table.status, table.runAfter),
    index('agent_tasks_channel_status_idx').on(table.channel, table.status),
    uniqueIndex('agent_tasks_user_idempotency_idx').on(table.userId, table.idempotencyKey),
  ]
);

/**
 * Agent Task Attempts table: one row per execution attempt (claim) of a task.
 * `id` doubles as the execution correlation ID used in logs and as the lease fencing token.
 */
export const agentTaskAttempts = pgTable(
  'agent_task_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    attemptNumber: integer('attempt_number').notNull(),
    // 'running' | 'succeeded' | 'failed' | 'retry_scheduled' | 'awaiting_confirmation' | 'cancelled' | 'interrupted'
    status: varchar('status', { length: 32 }).default('running').notNull(),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    metadata: jsonb('metadata').default({}).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [uniqueIndex('agent_task_attempts_task_attempt_idx').on(table.taskId, table.attemptNumber)]
);

/**
 * Agent Tool Calls table: ledger of every tool invocation requested by the model.
 * The (task_id, call_id) key makes side-effecting tools exactly-once-per-call across retries/restarts.
 */
export const agentToolCalls = pgTable(
  'agent_tool_calls',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => agentTasks.id, { onDelete: 'cascade' }),
    // Engine-assigned deterministic ID (call_<round>_<index>); never the provider's ID.
    callId: varchar('call_id', { length: 64 }).notNull(),
    toolName: varchar('tool_name', { length: 128 }).notNull(),
    args: jsonb('args').notNull(),
    // 'awaiting_confirmation' | 'approved' | 'rejected' | 'running' | 'succeeded' | 'failed'
    status: varchar('status', { length: 32 }).notNull(),
    // Sanitized, model-visible result string. `text` (not jsonb) so JSON text is stored verbatim.
    result: text('result'),
    errorCode: varchar('error_code', { length: 64 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('agent_tool_calls_task_call_idx').on(table.taskId, table.callId)]
);

/**
 * Reminders table: one-time reminders delivered by the durable reminder worker.
 * The table itself is the schedule: `next_attempt_at` is what the worker claims against.
 * `status`: scheduled | processing | sent (provider ACCEPTED it; see delivered_at for confirmed delivery)
 *           | failed | cancelled | completed (user marked done)
 */
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    remindAt: timestamp('remind_at', { withTimezone: true }).notNull(),
    // Snapshot of the user's IANA timezone when scheduled; used for display and re-interpretation.
    timezone: varchar('timezone', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).default('scheduled').notNull(),
    // Earliest time the worker may claim it. Always >= remind_at (enforced by a CHECK), so a
    // reminder can never be claimed before its scheduled instant.
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').default(0).notNull(),
    maxAttempts: integer('max_attempts').default(5).notNull(),
    lockedBy: uuid('locked_by'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    lastErrorCode: varchar('last_error_code', { length: 64 }),
    lastErrorMessage: text('last_error_message'),
    deliveryProvider: varchar('delivery_provider', { length: 16 }), // 'whatsapp' | 'mock'
    providerMessageId: varchar('provider_message_id', { length: 255 }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }), // provider accepted the send request
    deliveredAt: timestamp('delivered_at', { withTimezone: true }), // provider confirmed delivery (webhook)
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('reminders_due_idx').on(table.status, table.nextAttemptAt),
    index('reminders_user_status_remind_idx').on(table.userId, table.status, table.remindAt),
    index('reminders_provider_message_idx').on(table.providerMessageId),
    uniqueIndex('reminders_user_idempotency_idx').on(table.userId, table.idempotencyKey),
    check(
      'reminders_status_chk',
      sql`${table.status} in ('scheduled','processing','sent','failed','cancelled','completed')`
    ),
    check('reminders_title_len_chk', sql`char_length(${table.title}) between 1 and 1000`),
    check('reminders_attempts_chk', sql`${table.attempts} >= 0 and ${table.maxAttempts} >= 1`),
    check('reminders_never_early_chk', sql`${table.nextAttemptAt} >= ${table.remindAt}`),
  ]
);

/**
 * Browser connections: a website the user has authorized the assistant to use on their behalf.
 * The authenticated browser state (cookies / local storage) is stored ONLY as AES-256-GCM ciphertext
 * (`encrypted_state`), is scoped to one user and one origin, and is deleted on disconnect.
 * `status`: connected | expired | revoked
 */
export const browserConnections = pgTable(
  'browser_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Normalized origin, e.g. https://mail.example.com (never a path, never credentials).
    origin: varchar('origin', { length: 255 }).notNull(),
    label: varchar('label', { length: 80 }),
    status: varchar('status', { length: 16 }).default('connected').notNull(),
    // "v1.<iv>.<tag>.<ciphertext>" (base64url). Null once revoked.
    encryptedState: text('encrypted_state'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('browser_connections_user_origin_idx').on(table.userId, table.origin),
    check('browser_connections_status_chk', sql`${table.status} in ('connected','expired','revoked')`),
  ]
);

/**
 * Browser runs: one browser workflow (a live session plus its limits and checkpoint).
 * Only metadata is persisted: URLs without query/hash, counters, action kinds. No page content,
 * screenshots, form values or cookies. `status`: queued | running | waiting_for_user | completed | failed | cancelled
 */
export const browserRuns = pgTable(
  'browser_runs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => browserConnections.id, { onDelete: 'set null' }),
    status: varchar('status', { length: 24 }).default('queued').notNull(),
    // Hosts the run may navigate to (start host and its subdomains), fixed when the run is created.
    scopeHost: varchar('scope_host', { length: 255 }).notNull(),
    startUrl: text('start_url').notNull(),
    // Resume point: { url, generation, actions: [{ kind, at }] }. Query strings and fragments are stripped.
    checkpoint: jsonb('checkpoint').default({}).notNull(),
    stepCount: integer('step_count').default(0).notNull(),
    navigationCount: integer('navigation_count').default(0).notNull(),
    recoveryCount: integer('recovery_count').default(0).notNull(),
    // waiting_for_user: login_required | captcha | blocked | confirmation
    waitReason: varchar('wait_reason', { length: 32 }),
    errorCode: varchar('error_code', { length: 64 }),
    errorMessage: text('error_message'),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('browser_runs_user_status_idx').on(table.userId, table.status),
    index('browser_runs_status_activity_idx').on(table.status, table.lastActivityAt),
    uniqueIndex('browser_runs_user_idempotency_idx').on(table.userId, table.idempotencyKey),
    check(
      'browser_runs_status_chk',
      sql`${table.status} in ('queued','running','waiting_for_user','completed','failed','cancelled')`
    ),
  ]
);

/**
 * Browser handoffs: a short-lived, single-use grant that lets a user complete a login / MFA / CAPTCHA on their own
 * device through a remote browser, then lets the paused agent task resume.
 *
 * Only SHA-256 hashes of the secrets are stored (the link token and the browser-session secret); the plaintext
 * exists only in the link the user receives and in their cookie. Nothing here holds credentials, cookies or page
 * content: the authenticated browser state goes to `browser_connections`, encrypted.
 * `status`: pending (link sent) | active (opened, user is signing in) | completed | expired | cancelled | failed
 */
export const browserHandoffs = pgTable(
  'browser_handoffs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    taskId: uuid('task_id').references(() => agentTasks.id, { onDelete: 'set null' }),
    runId: uuid('run_id').references(() => browserRuns.id, { onDelete: 'set null' }),
    connectionId: uuid('connection_id').references(() => browserConnections.id, { onDelete: 'set null' }),
    // The only website this handoff may show (normalized origin). Extra identity-provider hosts come from config.
    origin: varchar('origin', { length: 255 }).notNull(),
    // origin + path the remote browser starts on (never a query string).
    targetUrl: text('target_url').notNull(),
    // login | mfa | captcha
    reason: varchar('reason', { length: 16 }).default('login').notNull(),
    status: varchar('status', { length: 16 }).default('pending').notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    // Hash of the secret held in the user's cookie once the link has been redeemed.
    sessionHash: varchar('session_hash', { length: 64 }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }),
    // The link can be opened until this time.
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    // Once opened, the remote session ends at this time at the latest.
    sessionExpiresAt: timestamp('session_expires_at', { withTimezone: true }),
    redeemedAt: timestamp('redeemed_at', { withTimezone: true }),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    failureCode: varchar('failure_code', { length: 64 }),
    // The WhatsApp link message was accepted by the provider.
    linkSentAt: timestamp('link_sent_at', { withTimezone: true }),
    // The user was told the outcome (connected / expired / cancelled / failed), exactly once.
    resultNotifiedAt: timestamp('result_notified_at', { withTimezone: true }),
    // The agent task created to continue the paused work.
    resumedTaskId: uuid('resumed_task_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('browser_handoffs_token_hash_idx').on(table.tokenHash),
    uniqueIndex('browser_handoffs_session_hash_idx').on(table.sessionHash),
    uniqueIndex('browser_handoffs_user_idempotency_idx').on(table.userId, table.idempotencyKey),
    index('browser_handoffs_user_status_idx').on(table.userId, table.status),
    index('browser_handoffs_status_expires_idx').on(table.status, table.expiresAt),
    index('browser_handoffs_run_idx').on(table.runId),
    check(
      'browser_handoffs_status_chk',
      sql`${table.status} in ('pending','active','completed','expired','cancelled','failed')`
    ),
    check('browser_handoffs_reason_chk', sql`${table.reason} in ('login','mfa','captcha')`),
  ]
);

/**
 * Gmail connections: one row per linked Google account per user.
 * The refresh token is stored encrypted at rest; access tokens are transient.
 * `status`: connected | expired | revoked
 */
export const gmailConnections = pgTable(
  'gmail_connections',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    googleEmail: varchar('google_email', { length: 255 }).notNull(),
    scopes: text('scopes').notNull(),
    encryptedRefreshToken: text('encrypted_refresh_token').notNull(),
    status: varchar('status', { length: 16 }).default('connected').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('gmail_connections_user_email_idx').on(table.userId, table.googleEmail),
    index('gmail_connections_user_status_idx').on(table.userId, table.status),
    check('gmail_connections_status_chk', sql`${table.status} in ('connected','expired','revoked')`),
  ]
);

/**
 * Gmail OAuth state: CSRF protection and PKCE code_verifier for the authorization flow.
 * Rows are short-lived (10 min TTL) and single-use.
 */
export const gmailOauthStates = pgTable(
  'gmail_oauth_states',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    state: varchar('state', { length: 128 }).notNull(),
    codeVerifier: varchar('code_verifier', { length: 128 }).notNull(),
    requestedScopes: text('requested_scopes').notNull(),
    redirectUri: text('redirect_uri').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('gmail_oauth_states_state_idx').on(table.state),
    index('gmail_oauth_states_expires_idx').on(table.expiresAt),
  ]
);

/**
 * Gmail send log: every email we send is recorded with an idempotency key
 * so that retries and tool replays cannot duplicate a send.
 */
export const gmailSendLog = pgTable(
  'gmail_send_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => gmailConnections.id, { onDelete: 'cascade' }),
    idempotencyKey: varchar('idempotency_key', { length: 128 }).notNull(),
    messageId: varchar('message_id', { length: 255 }),
    threadId: varchar('thread_id', { length: 255 }),
    recipient: text('recipient').notNull(),
    subject: text('subject').notNull(),
    status: varchar('status', { length: 16 }).default('sent').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('gmail_send_log_user_idempotency_idx').on(table.userId, table.idempotencyKey),
    index('gmail_send_log_connection_idx').on(table.connectionId),
  ]
);

/**
 * Workflow Memories table: user-approved preferences, reusable workflows, facts, and project context.
 * Enforces per-user ownership, approval state, and lifecycle.
 */
export const workflowMemories = pgTable(
  'workflow_memories',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 32 }).notNull(), // 'preference' | 'workflow' | 'fact' | 'project_context'
    title: varchar('title', { length: 255 }).notNull(),
    content: text('content').notNull(),
    searchKeywords: text('search_keywords'),
    source: varchar('source', { length: 32 }).default('explicit_user').notNull(), // 'explicit_user' | 'inferred' | 'system'
    provenance: text('provenance'),
    status: varchar('status', { length: 16 }).default('active').notNull(), // 'active' | 'archived' | 'expired'
    approvalState: varchar('approval_state', { length: 32 }).default('approved').notNull(), // 'approved' | 'pending_approval' | 'rejected'
    confidence: real('confidence').default(1.0).notNull(),
    project: varchar('project', { length: 128 }),
    integration: varchar('integration', { length: 64 }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('workflow_memories_user_status_approval_idx').on(table.userId, table.status, table.approvalState),
    index('workflow_memories_user_type_idx').on(table.userId, table.type),
    index('workflow_memories_user_project_idx').on(table.userId, table.project),
    index('workflow_memories_expires_idx').on(table.expiresAt),
    index('workflow_memories_updated_idx').on(table.updatedAt),
  ]
);

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
  messages: many(messages),
  sessions: many(sessions),
  authFlows: many(authFlows),
  gmailConnections: many(gmailConnections),
  workflowMemories: many(workflowMemories),
}));

export const authFlowsRelations = relations(authFlows, ({ one, many }) => ({
  user: one(users, {
    fields: [authFlows.userId],
    references: [users.id],
  }),
  challenges: many(authChallenges),
}));

export const authChallengesRelations = relations(authChallenges, ({ one }) => ({
  flow: one(authFlows, {
    fields: [authChallenges.authFlowId],
    references: [authFlows.id],
  }),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, {
    fields: [sessions.userId],
    references: [users.id],
  }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  user: one(users, {
    fields: [conversations.userId],
    references: [users.id],
  }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, {
    fields: [messages.conversationId],
    references: [conversations.id],
  }),
  user: one(users, {
    fields: [messages.userId],
    references: [users.id],
  }),
}));

export const gmailConnectionsRelations = relations(gmailConnections, ({ one, many }) => ({
  user: one(users, {
    fields: [gmailConnections.userId],
    references: [users.id],
  }),
  sendLogs: many(gmailSendLog),
}));

export const gmailSendLogRelations = relations(gmailSendLog, ({ one }) => ({
  user: one(users, {
    fields: [gmailSendLog.userId],
    references: [users.id],
  }),
  connection: one(gmailConnections, {
    fields: [gmailSendLog.connectionId],
    references: [gmailConnections.id],
  }),
}));

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type AuthFlow = typeof authFlows.$inferSelect;
export type NewAuthFlow = typeof authFlows.$inferInsert;

export type AuthChallenge = typeof authChallenges.$inferSelect;
export type NewAuthChallenge = typeof authChallenges.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type NewWebhookEvent = typeof webhookEvents.$inferInsert;

export type OutboxJob = typeof outboxJobs.$inferSelect;
export type NewOutboxJob = typeof outboxJobs.$inferInsert;

export type AgentTask = typeof agentTasks.$inferSelect;
export type NewAgentTask = typeof agentTasks.$inferInsert;

export type AgentTaskAttempt = typeof agentTaskAttempts.$inferSelect;
export type NewAgentTaskAttempt = typeof agentTaskAttempts.$inferInsert;

export type AgentToolCall = typeof agentToolCalls.$inferSelect;
export type NewAgentToolCall = typeof agentToolCalls.$inferInsert;

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;

export type BrowserConnection = typeof browserConnections.$inferSelect;
export type NewBrowserConnection = typeof browserConnections.$inferInsert;

export type BrowserRun = typeof browserRuns.$inferSelect;
export type NewBrowserRun = typeof browserRuns.$inferInsert;

export type BrowserHandoff = typeof browserHandoffs.$inferSelect;
export type NewBrowserHandoff = typeof browserHandoffs.$inferInsert;

export type GmailConnection = typeof gmailConnections.$inferSelect;
export type NewGmailConnection = typeof gmailConnections.$inferInsert;

export type GmailOauthState = typeof gmailOauthStates.$inferSelect;
export type NewGmailOauthState = typeof gmailOauthStates.$inferInsert;

export type GmailSendLogEntry = typeof gmailSendLog.$inferSelect;
export type NewGmailSendLogEntry = typeof gmailSendLog.$inferInsert;

export const workflowMemoriesRelations = relations(workflowMemories, ({ one }) => ({
  user: one(users, {
    fields: [workflowMemories.userId],
    references: [users.id],
  }),
}));

export type WorkflowMemory = typeof workflowMemories.$inferSelect;
export type NewWorkflowMemory = typeof workflowMemories.$inferInsert;
