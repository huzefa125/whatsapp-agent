// IMPORTANT: import this file FIRST in any DB-backed test. It points the app config at the test
// database before getConfig() caches anything.
import { randomUUID } from 'crypto';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasTestDb = Boolean(TEST_DATABASE_URL);

if (TEST_DATABASE_URL) {
  // These tests truncate agent tables; refuse to touch anything that is not clearly a test database.
  if (!/\/[^/?]*test[^/?]*(\?|$)/i.test(TEST_DATABASE_URL)) {
    throw new Error('TEST_DATABASE_URL must point at a database whose name contains "test"');
  }
  process.env.DATABASE_URL = TEST_DATABASE_URL;
}
// Tests must never reach a real model or run a background worker.
process.env.AI_PROVIDER = 'stub';
process.env.AGENT_WORKER_ENABLED = 'false';

import { getDb } from '../../src/db/client';
import { users, sessions, conversations, agentTasks } from '../../src/db/schema';
import { generateSessionToken, hashSessionToken } from '../../src/utils/otp';
import { eq, sql } from 'drizzle-orm';

export interface TestUser {
  id: string;
  token: string;
}

/** Creates a fully verified user plus a live session. Returns the raw bearer token. */
export async function createTestUser(opts: { verified?: boolean } = {}): Promise<TestUser> {
  const db = getDb();
  const verified = opts.verified ?? true;
  const suffix = randomUUID().slice(0, 8);
  const now = new Date();
  const [user] = await db
    .insert(users)
    .values({
      phoneNumber: `+1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}${suffix.slice(0, 2)}`.slice(0, 20),
      email: `agent-${suffix}@example.com`,
      phoneVerifiedAt: verified ? now : null,
      emailVerifiedAt: verified ? now : null,
    })
    .returning();
  const token = generateSessionToken();
  await db.insert(sessions).values({
    userId: user!.id,
    tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + 3_600_000),
  });
  return { id: user!.id, token };
}

export async function createTestConversation(userId: string): Promise<string> {
  const [conv] = await getDb().insert(conversations).values({ userId, title: 'test' }).returning();
  return conv!.id;
}

export async function deleteTestUser(userId: string): Promise<void> {
  await getDb().delete(users).where(eq(users.id, userId)); // cascades to tasks, sessions, conversations
}

export async function getTaskRow(taskId: string) {
  const [row] = await getDb().select().from(agentTasks).where(eq(agentTasks.id, taskId));
  return row;
}

/** Clears every agent table so leftovers from earlier runs cannot be claimed by this run's workers. */
export async function resetAgentTables(): Promise<void> {
  await getDb().execute(sql`TRUNCATE agent_tool_calls, agent_task_attempts, agent_tasks CASCADE`);
}
