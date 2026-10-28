/**
 * Live "chat with the agent" simulator. Uses YOUR real model from .env (costs API quota) but a FAKE WhatsApp:
 * nothing is sent to anyone, replies are printed. Reminders use the mock provider and are stored in your DB.
 *
 *   npm run chat:sim -- "+919876543210" "remind me to call mom in 2 minutes" "yes"
 *
 * Each argument after the phone number is one inbound message, sent in order. The phone is created as a verified
 * simulated user if missing. Use a database whose name contains "test" (it writes users/tasks/reminders).
 */
import 'dotenv/config';
process.env.REMINDER_PROVIDER = 'mock';
process.env.REMINDER_WORKER_ENABLED = 'false';
process.env.AGENT_WORKER_ENABLED = 'false';

import { eq } from 'drizzle-orm';
import { closeDatabaseConnection, getDb } from '../db/client';
import { reminders, users } from '../db/schema';
import { getAgentTaskService } from '../services/agent/engine/task-service';
import { OutboxService } from '../services/queue/outbox';
import { WhatsAppChannel, setWhatsAppChannelForTesting } from '../services/agent/whatsapp/channel';
import { WhatsAppReplyDispatcher } from '../services/agent/whatsapp/replies';
import { getReminderService } from '../services/reminders/reminder-service';
import { normalizePhoneNumber } from '../utils/normalization';
import type { IWhatsAppClient } from '../services/whatsapp/client';

async function main() {
  const [rawPhone, ...lines] = process.argv.slice(2);
  if (!rawPhone || lines.length === 0) throw new Error('usage: chat:sim "<+phone>" "<message 1>" "<message 2>" ...');
  if (!/test/i.test(process.env.DATABASE_URL ?? '')) throw new Error('Refusing: DATABASE_URL must name a "test" database');
  const phone = normalizePhoneNumber(rawPhone);

  const fake: IWhatsAppClient = {
    async sendTextMessage(r) {
      console.log(`\n  🤖 → ${r.to}\n${r.text.replace(/^/gm, '     ')}`);
      return { messagingProduct: 'whatsapp', providerMessageId: `wamid.sim.${Date.now()}`, recipientId: r.to };
    },
  };
  const db = getDb();
  const now = new Date();
  await db.insert(users).values({ phoneNumber: phone, email: `sim-${phone.slice(1)}@example.invalid`, phoneVerifiedAt: now, emailVerifiedAt: now }).onConflictDoNothing();
  const [user] = await db.select().from(users).where(eq(users.phoneNumber, phone));

  const tasks = getAgentTaskService();
  const outbox = new OutboxService();
  const dispatcher = new WhatsAppReplyDispatcher(fake);
  setWhatsAppChannelForTesting(new WhatsAppChannel(tasks, fake));

  for (const line of lines) {
    console.log(`\n  👤 ${phone}: ${line}`);
    await outbox.enqueueInboundMessage({
      type: 'text_message', providerMessageId: `wamid.sim.in.${Date.now()}.${Math.random()}`,
      senderPhoneNumber: phone.slice(1), text: line, timestamp: new Date(), phoneNumberId: 'SIM', raw: {},
    });
    // Like real time: keep working until nothing is runnable AND nothing is waiting out a retry (max ~3 min).
    const deadline = Date.now() + 180_000;
    for (;;) {
      const did = [await outbox.processNextJob(), await tasks.processNext(), await dispatcher.processNext()];
      if (did.some(Boolean)) continue;
      const open = await tasks.repo.latestForUser(user!.id, 'whatsapp', ['pending', 'running']);
      if (!open || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const tz = await getReminderService().getTimezone(user!.id);
  const rows = await db.select().from(reminders).where(eq(reminders.userId, user!.id));
  console.log(`\n── user timezone: ${tz ?? '(not set)'}`);
  for (const r of rows) console.log(`── reminder [${r.status}] "${r.title}" at ${r.remindAt.toISOString()} (${r.timezone})`);
}

main()
  .catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; })
  .finally(() => closeDatabaseConnection());
