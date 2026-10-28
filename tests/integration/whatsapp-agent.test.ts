import { hasTestDb, resetAgentTables, resetReminderTables } from '../helpers/test-db';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import crypto, { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { createApp } from '../../src/app';
import { getConfig } from '../../src/config/env';
import { closeDatabaseConnection, getDb } from '../../src/db/client';
import { agentTasks, messages, outboxJobs, reminders, users } from '../../src/db/schema';
import {
  AgentRunner,
  AgentTaskRepository,
  AgentTaskService,
  DefaultPermissionResolver,
  createDefaultToolRegistry,
} from '../../src/services/agent/engine';
import { OutboxService, setOutboxServiceForTesting } from '../../src/services/queue/outbox';
import {
  NOT_REGISTERED_REPLY,
  TOO_LONG_REPLY,
  WhatsAppChannel,
  parseDecision,
  setWhatsAppChannelForTesting,
} from '../../src/services/agent/whatsapp/channel';
import { MAX_REPLY_ATTEMPTS, WhatsAppReplyDispatcher } from '../../src/services/agent/whatsapp/replies';
import { getReminderService } from '../../src/services/reminders/reminder-service';
import { ReminderRepository } from '../../src/services/reminders/reminder-repository';
import { AppError, ExternalServiceError, RateLimitError } from '../../src/utils/errors';
import type { IWhatsAppClient } from '../../src/services/whatsapp/client';
import type { WhatsAppSendTextRequest } from '../../src/services/whatsapp/types';
import { ScriptedProvider, text, toolCalls, type ScriptStep } from '../helpers/scripted-provider';

class FakeWhatsApp implements IWhatsAppClient {
  readonly sent: Array<{ to: string; text: string }> = [];
  readonly failures: Error[] = [];
  async sendTextMessage(req: WhatsAppSendTextRequest) {
    const failure = this.failures.shift();
    if (failure) throw failure;
    this.sent.push({ to: req.to, text: req.text });
    return { messagingProduct: 'whatsapp', providerMessageId: `wamid.out.${randomUUID()}`, recipientId: req.to };
  }
  texts() {
    return this.sent.map((m) => m.text);
  }
}

interface WaUser {
  id: string;
  /** E.164, as stored. */
  phone: string;
  /** Digits only, as Meta sends it in `messages[].from`. */
  from: string;
}

describe.skipIf(!hasTestDb)('WhatsApp → agent → WhatsApp (mocked model and WhatsApp)', () => {
  const app = createApp();
  const secret = getConfig().WHATSAPP_APP_SECRET;
  const outbox = new OutboxService();
  let client: FakeWhatsApp;
  let service: AgentTaskService;
  let provider: ScriptedProvider;
  let dispatcher: WhatsAppReplyDispatcher;
  const created: string[] = [];

  beforeAll(() => setOutboxServiceForTesting(outbox));
  afterAll(async () => {
    setOutboxServiceForTesting(null);
    setWhatsAppChannelForTesting(null);
    await closeDatabaseConnection();
  });

  beforeEach(async () => {
    await resetAgentTables();
    await resetReminderTables();
    await getDb().execute(sql`TRUNCATE outbox_jobs, webhook_events`);
    client = new FakeWhatsApp();
    dispatcher = new WhatsAppReplyDispatcher(client);
    install([]);
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await getDb().delete(users).where(eq(users.id, id));
  });

  function install(steps: ScriptStep[]) {
    const repo = new AgentTaskRepository();
    const registry = createDefaultToolRegistry();
    provider = new ScriptedProvider(...steps);
    const runner = new AgentRunner({
      repo,
      registry,
      permissions: new DefaultPermissionResolver(),
      getProvider: () => provider,
      systemContext: (userId) => getReminderService().buildAgentContext(userId), // same wiring as AgentTaskService
      config: { retryBackoffBaseMs: 0 },
    });
    service = new AgentTaskService({ repo, registry, runner });
    setWhatsAppChannelForTesting(new WhatsAppChannel(service, client));
  }

  async function mkUser(opts: { timezone?: string | null; verified?: boolean } = {}): Promise<WaUser> {
    const digits = `1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const now = new Date();
    const verified = opts.verified ?? true;
    const [u] = await getDb()
      .insert(users)
      .values({
        phoneNumber: `+${digits}`,
        email: `wa-${randomUUID().slice(0, 8)}@example.com`,
        phoneVerifiedAt: verified ? now : null,
        emailVerifiedAt: verified ? now : null,
        timezone: opts.timezone === undefined ? 'Asia/Kolkata' : opts.timezone,
      })
      .returning();
    created.push(u!.id);
    return { id: u!.id, phone: `+${digits}`, from: digits };
  }

  /** Sends a correctly signed Meta webhook for one inbound text message. Returns its wamid. */
  async function inbound(from: string, body: string, wamid = `wamid.${randomUUID()}`): Promise<string> {
    const payload = JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550000000', phone_number_id: 'PN_1' },
                contacts: [{ profile: { name: 'Test' }, wa_id: from }],
                messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }],
              },
            },
          ],
        },
      ],
    });
    const signature = `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-Hub-Signature-256', signature)
      .send(payload);
    expect(res.status).toBe(200);
    return wamid;
  }

  /** Runs every worker (outbox, agent engine, reply dispatcher) until nothing is left to do. */
  async function pump(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const did = [await outbox.processNextJob(), await service.processNext(), await dispatcher.processNext()];
      if (!did.some(Boolean)) return;
    }
    throw new Error('pump did not settle');
  }

  const tasksOf = async (userId: string) => getDb().select().from(agentTasks).where(eq(agentTasks.userId, userId));
  const remindersOf = async (userId: string) => getDb().select().from(reminders).where(eq(reminders.userId, userId));
  const threeAmTomorrowIst = () => ({
    kind: 'local' as const,
    date: new Date(Date.now() + 29.5 * 3_600_000).toISOString().slice(0, 10),
    time: '03:00',
  });

  // ------------------------------------------------------------------ 1. the real round trip

  it('answers an inbound message by running a tool and replying on WhatsApp', async () => {
    const u = await mkUser();
    install([
      toolCalls({ name: 'calculator', rawArguments: '{"expression":"6*7"}' }),
      text('6 × 7 = 42'),
    ]);
    await inbound(u.from, 'what is 6*7?');
    await pump();

    expect(client.sent).toEqual([{ to: u.phone, text: '6 × 7 = 42' }]);
    const [task] = await tasksOf(u.id);
    expect(task).toMatchObject({ status: 'succeeded', channel: 'whatsapp', replyKey: 'succeeded' });
    // the model saw the tool result, not just the question
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain('42');

    const rows = await getDb().select().from(messages).where(eq(messages.userId, u.id));
    expect(rows.map((r) => r.role).sort()).toEqual(['assistant', 'user']);
    expect(rows.find((r) => r.role === 'user')!.providerMessageId).toMatch(/^wamid\./);
  });

  it('opens the 24h WhatsApp window so reminders can be sent as free text', async () => {
    const u = await mkUser();
    install([text('hi')]);
    await inbound(u.from, 'hello');
    await pump();
    const at = await new ReminderRepository().lastInboundAt(u.id);
    expect(at).not.toBeNull();
    expect(Date.now() - at!.getTime()).toBeLessThan(60_000);
  });

  it('survives Meta redelivering the same message (webhook and job level)', async () => {
    const u = await mkUser();
    install([text('once')]);
    const wamid = await inbound(u.from, 'hello');
    await inbound(u.from, 'hello', wamid); // Meta retry: deduped at the webhook
    await pump();
    // ...and even if the job itself runs again (crash after enqueue, before the job was marked complete)
    await getDb().update(outboxJobs).set({ status: 'pending', nextRunAt: new Date() });
    await pump();

    expect(await tasksOf(u.id)).toHaveLength(1);
    expect(client.sent).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);
    expect(await getDb().select().from(outboxJobs)).toHaveLength(1);
  });

  // ------------------------------------------------------------------ 2. who may talk to the model

  it('does not call the model or create an account for unknown or unverified numbers', async () => {
    const stranger = `1555${Math.floor(1_000_000 + Math.random() * 8_999_999)}`;
    const half = await mkUser({ verified: false });
    install([text('should never be used')]);
    await inbound(stranger, 'hi');
    await inbound(half.from, 'hi');
    await pump();

    expect(provider.calls).toHaveLength(0);
    expect(client.texts()).toEqual([NOT_REGISTERED_REPLY, NOT_REGISTERED_REPLY]);
    const rows = await getDb().select().from(users).where(eq(users.phoneNumber, `+${stranger}`));
    expect(rows).toHaveLength(0);
    expect(await tasksOf(half.id)).toHaveLength(0);
  });

  it('keeps users isolated: one user\'s YES never answers another user\'s confirmation', async () => {
    const alice = await mkUser();
    const bob = await mkUser();
    install([
      toolCalls({ name: 'create_reminder', rawArguments: JSON.stringify({ title: 'bob', when: threeAmTomorrowIst() }) }),
      text('Hello Alice'),
    ]);
    await inbound(bob.from, 'remind me at 3am');
    await pump();
    const [bobTask] = await tasksOf(bob.id);
    expect(bobTask!.status).toBe('awaiting_confirmation');

    await inbound(alice.from, 'yes');
    await pump();

    expect((await tasksOf(bob.id))[0]!.status).toBe('awaiting_confirmation'); // untouched
    expect(await remindersOf(bob.id)).toHaveLength(0);
    expect(await tasksOf(alice.id)).toHaveLength(1); // her "yes" was just a normal message for her own agent
    expect(client.sent.filter((m) => m.to === alice.phone).map((m) => m.text)).toEqual(['Hello Alice']);
  });

  // ------------------------------------------------------------------ 3. conversation, clarification, follow-up

  it('asks a clarifying question, keeps the conversation, and finishes on the follow-up', async () => {
    const u = await mkUser({ timezone: null });
    install([
      text('Which city or timezone are you in?'),
      toolCalls({ name: 'set_timezone', rawArguments: '{"timezone":"Asia/Kolkata"}' }),
      toolCalls({ name: 'create_reminder', rawArguments: JSON.stringify({ title: 'call mom', when: { kind: 'relative', amount: 30, unit: 'minutes' } }) }),
      text('Done, I will remind you in 30 minutes.'),
    ]);

    await inbound(u.from, 'remind me to call mom in 30 minutes');
    await pump();
    expect(client.texts()).toEqual(['Which city or timezone are you in?']);
    expect(await remindersOf(u.id)).toHaveLength(0);
    // the model was told the timezone is missing and how to fix it
    expect(provider.calls[0]!.messages[0]!.content).toContain('set_timezone');

    await inbound(u.from, 'Mumbai');
    await pump();

    expect(client.texts()[1]).toBe('Done, I will remind you in 30 minutes.');
    const [saved] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(saved!.timezone).toBe('Asia/Kolkata');
    const [reminder] = await remindersOf(u.id);
    expect(reminder).toMatchObject({ title: 'call mom', status: 'scheduled' });
    expect(reminder!.remindAt.getTime() - Date.now()).toBeGreaterThan(25 * 60_000);

    // continuity: the 2nd task's history contains the original request and our question
    const history = provider.calls[1]!.messages.map((m) => ('content' in m ? String(m.content) : '')).join('\n');
    expect(history).toContain('remind me to call mom in 30 minutes');
    expect(history).toContain('Which city or timezone are you in?');
    expect(history).toContain('Mumbai');
  });

  it('suggests (but does not assume) a timezone from an Indian number', async () => {
    const u = await mkUser({ timezone: null });
    await getDb().update(users).set({ phoneNumber: '+919876500001' }).where(eq(users.id, u.id));
    install([text('Are you on Asia/Kolkata time?')]);
    await inbound('919876500001', 'remind me tomorrow at 10');
    await pump();
    const prompt = String(provider.calls[0]!.messages[0]!.content);
    expect(prompt).toContain('suggests Asia/Kolkata');
    expect(prompt).toContain('only a guess');
    const [saved] = await getDb().select().from(users).where(eq(users.id, u.id));
    expect(saved!.timezone).toBeNull(); // nothing saved until the user confirms
  });

  // ------------------------------------------------------------------ 4. confirmations

  it('asks for confirmation over WhatsApp and only acts after YES', async () => {
    const u = await mkUser();
    install([
      toolCalls({ name: 'create_reminder', rawArguments: JSON.stringify({ title: 'early flight', when: threeAmTomorrowIst() }) }),
      text('Reminder set for 03:00.'),
    ]);
    await inbound(u.from, 'remind me about my early flight at 3am');
    await pump();

    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toMatch(/^Please confirm: .*early flight.*\n\nReply YES to go ahead or NO to cancel\.$/s);
    expect(await remindersOf(u.id)).toHaveLength(0); // nothing written yet

    await inbound(u.from, 'hmm what?'); // not an answer: re-prompt, no new task, no model call
    await pump();
    expect(client.sent).toHaveLength(2);
    expect(client.sent[1]!.text).toContain('Reply YES to go ahead or NO to cancel');
    expect(await tasksOf(u.id)).toHaveLength(1);
    expect(provider.calls).toHaveLength(1);

    await inbound(u.from, 'Yes!');
    await pump();

    expect(client.texts()[2]).toBe('Reminder set for 03:00.');
    expect(client.sent).toHaveLength(3);
    expect(await remindersOf(u.id)).toHaveLength(1);
    expect(await tasksOf(u.id)).toHaveLength(1); // "Yes!" was not treated as a new request
  });

  it('does nothing when the user answers NO', async () => {
    const u = await mkUser();
    install([
      toolCalls({ name: 'create_reminder', rawArguments: JSON.stringify({ title: 'x', when: threeAmTomorrowIst() }) }),
      text('Okay, I have not set it.'),
    ]);
    await inbound(u.from, 'remind me at 3am');
    await pump();
    await inbound(u.from, 'no');
    await pump();

    expect(await remindersOf(u.id)).toHaveLength(0);
    expect(client.texts().at(-1)).toBe('Okay, I have not set it.');
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain('USER_DECLINED');
  });

  it('tells the user when a confirmation timed out', async () => {
    const u = await mkUser();
    install([toolCalls({ name: 'create_reminder', rawArguments: JSON.stringify({ title: 'x', when: threeAmTomorrowIst() }) })]);
    await inbound(u.from, 'remind me at 3am');
    await pump();
    await getDb().update(agentTasks).set({ confirmationExpiresAt: new Date(Date.now() - 1000) });
    await service.recover();
    await pump();

    expect((await tasksOf(u.id))[0]!.status).toBe('cancelled');
    expect(client.texts().at(-1)).toContain('timed out before you confirmed');
    expect(await remindersOf(u.id)).toHaveLength(0);
  });

  it('parses confirmation words strictly', () => {
    expect(parseDecision(' YES. ')).toBe('approve');
    expect(parseDecision('👍')).toBe('approve');
    expect(parseDecision('no')).toBe('reject');
    expect(parseDecision('cancel')).toBe('reject');
    expect(parseDecision('yes please also add milk')).toBeNull();
    expect(parseDecision('not now')).toBeNull();
  });

  // ------------------------------------------------------------------ 5. status, errors, retries, cancellation

  it('cancels a queued request when the user says "cancel", before the model is ever called', async () => {
    const u = await mkUser();
    install([text('never')]);
    await inbound(u.from, 'do a long thing');
    await outbox.processNextJob(); // task now exists and is pending; no worker has claimed it
    await inbound(u.from, 'cancel');
    await pump();

    expect((await tasksOf(u.id))[0]!.status).toBe('cancelled');
    expect(provider.calls).toHaveLength(0);
    expect(client.texts()).toEqual(["Okay, I've cancelled that."]);
  });

  it('reports a permanent AI failure to the user in plain words', async () => {
    const u = await mkUser();
    install([new AppError('bad key sk-secret-123', 401, 'AI_AUTH_FAILED')]);
    await inbound(u.from, 'hello');
    await pump();

    const [task] = await tasksOf(u.id);
    expect(task).toMatchObject({ status: 'failed', errorCode: 'AI_PROVIDER_UNAVAILABLE' });
    expect(client.texts()).toEqual(["Sorry, I couldn't complete that. The AI service is not configured correctly. Please try again."]);
    expect(client.texts().join()).not.toContain('sk-secret');
  });

  it('retries transient AI errors and sends exactly one final answer', async () => {
    const u = await mkUser();
    install([new RateLimitError('429'), new ExternalServiceError('ai', '503'), text('Third time lucky')]);
    await inbound(u.from, 'hello');
    await pump();

    const [task] = await tasksOf(u.id);
    expect(task).toMatchObject({ status: 'succeeded', attempts: 3 });
    expect(client.texts()).toEqual(['Third time lucky']);
  });

  it('gives up after the retry budget and tells the user once', async () => {
    const u = await mkUser();
    install([new RateLimitError('429'), new RateLimitError('429'), new RateLimitError('429')]);
    await inbound(u.from, 'hello');
    await pump();

    expect((await tasksOf(u.id))[0]).toMatchObject({ status: 'failed', attempts: 3, errorCode: 'AI_RATE_LIMITED' });
    expect(client.sent).toHaveLength(1);
    expect(client.sent[0]!.text).toContain("couldn't complete that");
  });

  it('rejects over-long messages with a clear reply instead of dead-lettering', async () => {
    const u = await mkUser();
    install([text('never')]);
    await inbound(u.from, 'x'.repeat(getConfig().AGENT_MAX_REQUEST_CHARS + 50));
    await pump();

    expect(client.texts()).toEqual([TOO_LONG_REPLY]);
    expect(await tasksOf(u.id)).toHaveLength(0);
    expect(await getDb().select().from(outboxJobs)).toMatchObject([{ status: 'completed' }]);
  });

  // ------------------------------------------------------------------ 6. reply delivery and restarts

  it('retries a failed WhatsApp send with backoff and never sends twice', async () => {
    const u = await mkUser();
    install([text('the answer')]);
    client.failures.push(new ExternalServiceError('whatsapp', 'down', { statusCode: 503 }));
    await inbound(u.from, 'hello');
    await pump();

    let [task] = await tasksOf(u.id);
    expect(client.sent).toHaveLength(0);
    expect(task).toMatchObject({ replyKey: null, replyAttempts: 1, replyError: 'PROVIDER_UNAVAILABLE' });
    expect(task!.replyNextAt.getTime()).toBeGreaterThan(Date.now()); // backing off, not hammering

    await getDb().update(agentTasks).set({ replyNextAt: new Date() });
    await pump();
    await pump();

    [task] = await tasksOf(u.id);
    expect(client.texts()).toEqual(['the answer']);
    expect(task).toMatchObject({ replyKey: 'succeeded', replyAttempts: 0, replyError: null });
  });

  it('stops retrying a permanently undeliverable reply and records why', async () => {
    const u = await mkUser();
    install([text('the answer')]);
    client.failures.push(new AppError('bad number', 400, 'WHATSAPP_INVALID_RECIPIENT'));
    await inbound(u.from, 'hello');
    await pump();
    await getDb().update(agentTasks).set({ replyNextAt: new Date() });
    await pump();

    expect(client.sent).toHaveLength(0);
    expect((await tasksOf(u.id))[0]).toMatchObject({ replyKey: 'succeeded', replyError: 'INVALID_RECIPIENT' });
  });

  it('gives up after the attempt budget', async () => {
    const u = await mkUser();
    install([text('the answer')]);
    for (let i = 0; i < MAX_REPLY_ATTEMPTS; i++) client.failures.push(new ExternalServiceError('whatsapp', 'down', { statusCode: 500 }));
    await inbound(u.from, 'hello');
    for (let i = 0; i < MAX_REPLY_ATTEMPTS + 1; i++) {
      await pump();
      await getDb().update(agentTasks).set({ replyNextAt: new Date() });
    }
    expect((await tasksOf(u.id))[0]).toMatchObject({ replyKey: 'succeeded', replyError: 'PROVIDER_UNAVAILABLE' });
    expect(client.sent).toHaveLength(0);
  });

  it('lets only one of several dispatcher instances send a given reply', async () => {
    const u = await mkUser();
    install([text('only once')]);
    await inbound(u.from, 'hello');
    await outbox.processNextJob();
    await service.processNext();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => new WhatsAppReplyDispatcher(client).processNext())
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(client.texts()).toEqual(['only once']);
  });

  it('recovers after a restart: stranded outbox job, dead agent worker, and an unsent reply', async () => {
    const u = await mkUser();
    install([text('survived')]);
    await inbound(u.from, 'hello');

    // process died while the outbox job was "processing"
    await getDb().update(outboxJobs).set({ status: 'processing', updatedAt: new Date(Date.now() - 10 * 60_000) });
    expect(await outbox.processNextJob()).toBe(false); // stuck: nothing is claimable
    expect(await outbox.recoverStaleJobs()).toBe(1);
    await outbox.processNextJob();

    // process died mid-task: running with an expired lease
    const claimed = await service.repo.claimNext(60_000);
    expect(claimed).not.toBeNull();
    await getDb().update(agentTasks).set({ leaseExpiresAt: new Date(Date.now() - 1000) });
    expect(await service.recover()).toMatchObject({ requeued: 1 });

    // the task finishes, but the process dies before sending: a brand-new dispatcher still owes the reply
    await service.processNext();
    expect(client.sent).toHaveLength(0);
    await new WhatsAppReplyDispatcher(client).processNext();

    expect(client.texts()).toEqual(['survived']);
    expect((await tasksOf(u.id))[0]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('does not recover a live outbox job', async () => {
    const u = await mkUser();
    install([text('x')]);
    await inbound(u.from, 'hello');
    await getDb().update(outboxJobs).set({ status: 'processing', updatedAt: new Date() });
    expect(await outbox.recoverStaleJobs()).toBe(0);
    expect(u.id).toBeTruthy();
  });
});
