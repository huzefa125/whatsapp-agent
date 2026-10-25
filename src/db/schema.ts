import { pgTable, uuid, varchar, text, timestamp, jsonb, integer, boolean, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

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

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  conversations: many(conversations),
  messages: many(messages),
  sessions: many(sessions),
  authFlows: many(authFlows),
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
