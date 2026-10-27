import { hasTestDb, createTestUser, deleteTestUser, resetAgentTables, TestUser } from '../helpers/test-db';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '../../src/app';
import { closeDatabaseConnection, getDb } from '../../src/db/client';
import { agentTasks } from '../../src/db/schema';
import {
  AgentRunner,
  AgentTaskRepository,
  AgentTaskService,
  ToolRegistry,
  calculatorTool,
  setAgentTaskServiceForTesting,
  type ToolDefinition,
} from '../../src/services/agent/engine';
import { ScriptedProvider, text, toolCalls, type ScriptStep } from '../helpers/scripted-provider';

describe.skipIf(!hasTestDb)('Agent task API', () => {
  const app = createApp();
  let alice: TestUser;
  let bob: TestUser;
  let service: AgentTaskService;
  const spy = vi.fn();

  const sendTool: ToolDefinition<{ to: string }, { sent: boolean }> = {
    name: 'send_message',
    description: 'Sends a message',
    inputSchema: z.object({ to: z.string().max(40) }),
    permissions: ['messaging:send'],
    sideEffect: 'non_idempotent',
    requiresConfirmation: true,
    timeoutMs: 500,
    retry: { maxRetries: 0, backoffMs: 0 },
    describeCall: (i) => `Message ${i.to}`,
    async execute(input) {
      spy(input);
      return { sent: true };
    },
  };

  function install(steps: ScriptStep[]) {
    const repo = new AgentTaskRepository();
    const registry = new ToolRegistry().register(calculatorTool).register(sendTool);
    const provider = new ScriptedProvider(...steps);
    const runner = new AgentRunner({
      repo,
      registry,
      permissions: { resolve: async (userId) => ({ userId, permissions: new Set(['utility:read', 'messaging:send']) }) },
      getProvider: () => provider,
      config: { retryBackoffBaseMs: 0 },
    });
    service = new AgentTaskService({ repo, registry, runner });
    setAgentTaskServiceForTesting(service);
    return provider;
  }

  const as = (u: TestUser) => ({ Authorization: `Bearer ${u.token}` });
  const drain = async () => {
    while (await service.processNext()) {
      /* run everything runnable */
    }
  };

  beforeAll(async () => {
    await resetAgentTables();
    alice = await createTestUser();
    bob = await createTestUser();
  });

  afterEach(async () => {
    spy.mockClear();
    await getDb().delete(agentTasks);
  });

  afterAll(async () => {
    setAgentTaskServiceForTesting(null);
    await deleteTestUser(alice.id);
    await deleteTestUser(bob.id);
    await closeDatabaseConnection();
  });

  it('requires a valid session on every endpoint', async () => {
    install([]);
    const id = '11111111-1111-4111-8111-111111111111';
    for (const call of [
      request(app).post('/api/agent/tasks').send({ request: 'x' }),
      request(app).get('/api/agent/tasks'),
      request(app).get(`/api/agent/tasks/${id}`),
      request(app).post(`/api/agent/tasks/${id}/cancel`),
      request(app).post(`/api/agent/tasks/${id}/confirm`).send({ callId: 'a', decision: 'approve' }),
    ]) {
      expect((await call).status).toBe(401);
    }
    const bad = await request(app).get('/api/agent/tasks').set('Authorization', 'Bearer not-a-real-token');
    expect(bad.status).toBe(401);
  });

  it('creates a task (202), runs it, and returns a safe public view', async () => {
    install([text('Hi!')]);
    const created = await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: '  hello  ' });
    expect(created.status).toBe(202);
    expect(created.body.status).toBe('success');
    expect(created.body.data).toMatchObject({ status: 'pending', taskType: 'agent_request', input: { request: 'hello' }, attempts: 0 });

    await drain();
    const fetched = await request(app).get(`/api/agent/tasks/${created.body.data.id}`).set(as(alice));
    expect(fetched.status).toBe(200);
    expect(fetched.body.data).toMatchObject({ status: 'succeeded', result: { response: 'Hi!' }, error: null });
    for (const internal of ['transcript', 'lockedBy', 'leaseExpiresAt', 'userId', 'idempotencyKey']) {
      expect(fetched.body.data).not.toHaveProperty(internal);
    }
  });

  it('takes identity only from the session, ignoring userId in the body', async () => {
    install([]);
    const res = await request(app)
      .post('/api/agent/tasks')
      .set(as(alice))
      .send({ request: 'x', userId: bob.id, user_id: bob.id });
    expect(res.status).toBe(202);
    const rows = await getDb().select().from(agentTasks);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(alice.id);
  });

  it('validates input with 400s', async () => {
    install([]);
    const post = (body: unknown) => request(app).post('/api/agent/tasks').set(as(alice)).send(body as object);
    expect((await post({})).status).toBe(400);
    expect((await post({ request: '   ' })).status).toBe(400);
    expect((await post({ request: 'x', conversationId: 'not-a-uuid' })).status).toBe(400);
    expect((await post({ request: 'x'.repeat(4001) })).status).toBe(400);
    expect((await request(app).get('/api/agent/tasks/not-a-uuid').set(as(alice))).status).toBe(400);
    expect((await request(app).get('/api/agent/tasks?limit=1000').set(as(alice))).status).toBe(400);
    expect((await request(app).get('/api/agent/tasks?status=bogus').set(as(alice))).status).toBe(400);
  });

  it('returns 404 (not 403) for a conversation the caller does not own', async () => {
    install([]);
    const { createTestConversation } = await import('../helpers/test-db');
    const bobsConversation = await createTestConversation(bob.id);
    const res = await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: 'x', conversationId: bobsConversation });
    expect(res.status).toBe(404);
  });

  it('replays Idempotency-Key requests without creating a second task', async () => {
    install([]);
    const send = (body: object) =>
      request(app).post('/api/agent/tasks').set(as(alice)).set('Idempotency-Key', 'abc-123').send(body);
    const first = await send({ request: 'same' });
    const replay = await send({ request: 'same' });
    const conflict = await send({ request: 'different' });
    expect([first.status, replay.status, conflict.status]).toEqual([202, 200, 409]);
    expect(replay.body.data.id).toBe(first.body.data.id);
    expect(await getDb().select().from(agentTasks)).toHaveLength(1);
  });

  it('lists only the caller’s tasks with status filter and pagination', async () => {
    install([text('a'), text('b')]);
    const ids: string[] = [];
    for (const r of ['one', 'two', 'three']) {
      ids.push((await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: r })).body.data.id);
    }
    await request(app).post('/api/agent/tasks').set(as(bob)).send({ request: 'bobs' });
    await service.processNext();
    await service.processNext();

    const all = await request(app).get('/api/agent/tasks').set(as(alice));
    expect(all.body.data).toHaveLength(3);
    expect(all.body.data.map((t: { id: string }) => t.id)).toEqual([...ids].reverse()); // newest first

    const succeeded = await request(app).get('/api/agent/tasks?status=succeeded').set(as(alice));
    expect(succeeded.body.data.every((t: { status: string }) => t.status === 'succeeded')).toBe(true);

    const page = await request(app).get('/api/agent/tasks?limit=2&offset=2').set(as(alice));
    expect(page.body.data).toHaveLength(1);

    const bobs = await request(app).get('/api/agent/tasks').set(as(bob));
    expect(bobs.body.data).toHaveLength(1);
  });

  it('hides other users’ tasks behind 404 for read, cancel and confirm', async () => {
    install([]);
    const id = (await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: 'private' })).body.data.id;
    expect((await request(app).get(`/api/agent/tasks/${id}`).set(as(bob))).status).toBe(404);
    expect((await request(app).post(`/api/agent/tasks/${id}/cancel`).set(as(bob))).status).toBe(404);
    expect(
      (await request(app).post(`/api/agent/tasks/${id}/confirm`).set(as(bob)).send({ callId: 'call_1_1', decision: 'approve' })).status
    ).toBe(404);
    expect((await request(app).get(`/api/agent/tasks/${id}`).set(as(alice))).body.data.status).toBe('pending');
  });

  it('cancels a pending task and refuses to cancel a finished one', async () => {
    install([text('done')]);
    const a = (await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: 'a' })).body.data.id;
    const cancelled = await request(app).post(`/api/agent/tasks/${a}/cancel`).set(as(alice));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');
    expect((await request(app).post(`/api/agent/tasks/${a}/cancel`).set(as(alice))).status).toBe(409);

    const b = (await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: 'b' })).body.data.id;
    await drain();
    expect((await request(app).post(`/api/agent/tasks/${b}/cancel`).set(as(alice))).status).toBe(409);
  });

  it('runs the confirmation flow end to end over HTTP', async () => {
    install([toolCalls({ name: 'send_message', rawArguments: '{"to":"+15550001111"}' }), text('Sent.')]);
    const id = (await request(app).post('/api/agent/tasks').set(as(alice)).send({ request: 'message them' })).body.data.id;
    await drain();

    const waiting = await request(app).get(`/api/agent/tasks/${id}`).set(as(alice));
    expect(waiting.body.data.status).toBe('awaiting_confirmation');
    expect(waiting.body.data.pendingConfirmation).toMatchObject({ callId: 'call_1_1', toolName: 'send_message', summary: 'Message +15550001111' });
    expect(spy).not.toHaveBeenCalled();

    expect((await request(app).post(`/api/agent/tasks/${id}/confirm`).set(as(alice)).send({ callId: 'call_1_1' })).status).toBe(400);
    const confirmed = await request(app).post(`/api/agent/tasks/${id}/confirm`).set(as(alice)).send({ callId: 'call_1_1', decision: 'approve' });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('pending');
    expect((await request(app).post(`/api/agent/tasks/${id}/confirm`).set(as(alice)).send({ callId: 'call_1_1', decision: 'approve' })).status).toBe(409);

    await drain();
    expect(spy).toHaveBeenCalledTimes(1);
    expect((await request(app).get(`/api/agent/tasks/${id}`).set(as(alice))).body.data).toMatchObject({
      status: 'succeeded',
      pendingConfirmation: null,
      result: { response: 'Sent.' },
    });
  });
});
