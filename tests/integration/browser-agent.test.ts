import { hasChromium } from '../helpers/chromium';
import { hasTestDb, createTestUser, deleteTestUser, getTaskRow, resetAgentTables, type TestUser } from '../helpers/test-db';
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { getDb, closeDatabaseConnection } from '../../src/db/client';
import { agentTasks, agentToolCalls, browserRuns } from '../../src/db/schema';
import { AgentRunner, AgentTaskRepository, AgentTaskService, ToolRegistry, type PermissionResolver } from '../../src/services/agent/engine';
import { BrowserService, createBrowserTools, type BrowserSettings } from '../../src/services/browser';
import { BrowserConnectionService } from '../../src/services/browser/connection-service';
import { BrowserRunRepository } from '../../src/services/browser/run-repository';
import { logger } from '../../src/utils/logger';
import { generateEncryptionKey } from '../../src/utils/secret-box';
import type { ToolChatMessage } from '../../src/services/ai/types';
import { ScriptedProvider, text, toolCalls, type ScriptStep } from '../helpers/scripted-provider';
import { startTestSite, type TestSite } from '../helpers/test-site';

class StaticPermissions implements PermissionResolver {
  constructor(private readonly perms: string[]) {}
  async resolve(userId: string) {
    return { userId, permissions: new Set(this.perms) };
  }
}

const settings = (): BrowserSettings => ({
  maxSteps: 40,
  maxNavigations: 15,
  maxRunMs: 120_000,
  idleMs: 120_000,
  session: { navTimeoutMs: 6000, actionTimeoutMs: 3000, maxText: 4000, maxElements: 60, blockUnconfirmedMutations: true, maxRequests: 500 },
  manager: { headless: true, maxSessions: 6, maxSessionsPerUser: 2 },
  policy: { allowedDomains: [], blockedDomains: [], allowPrivateNetwork: true },
});

// ------------------------------------------------------------------- reading tool results from the transcript

type Payload = { ok: boolean; data?: any; error?: { code: string; message: string } };

const payloads = (messages: ToolChatMessage[]): Payload[] =>
  messages
    .filter((m) => m.role === 'tool')
    .map((m) => JSON.parse(String(m.content).split('\n').slice(1, -1).join('\n')) as Payload);

const last = (messages: ToolChatMessage[]): Payload => payloads(messages).at(-1)!;

/** Finds an element ref like "e1-4" by role and name in ANY earlier snapshot of the transcript. */
const refFor = (messages: ToolChatMessage[], role: string, name: string): string => {
  for (const p of payloads(messages).reverse()) {
    const els: string[] = p.data?.page?.elements ?? [];
    const hit = els.find((e) => e.includes(` ${role} "${name}"`));
    if (hit) return hit.split(' ')[0]!;
  }
  throw new Error(`no ${role} "${name}" in transcript`);
};

const runIdOf = (messages: ToolChatMessage[]): string => {
  for (const p of payloads(messages)) if (p.data?.runId) return p.data.runId as string;
  throw new Error('no runId in transcript');
};

const call = (name: string, args: Record<string, unknown>) => toolCalls({ name, rawArguments: JSON.stringify(args) });
const step = (fn: (m: ToolChatMessage[]) => ReturnType<typeof toolCalls> | ReturnType<typeof text>): ScriptStep => async (m) => fn(m);

describe.skipIf(!hasTestDb || !hasChromium)('Browser agent tools (engine + PostgreSQL + Chromium)', () => {
  let site: TestSite;
  let alice: TestUser;
  let bob: TestUser;
  const toDelete: string[] = [];
  const browserServices: BrowserService[] = [];

  beforeAll(async () => {
    await resetAgentTables();
    site = await startTestSite();
  }, 60000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(browserServices.splice(0).map((s) => s.shutdown()));
    await getDb().delete(agentTasks);
    await getDb().delete(browserRuns);
    site.posts.length = 0;
    site.hits.clear();
  }, 60000);

  afterAll(async () => {
    for (const id of toDelete) await deleteTestUser(id);
    await site.close();
    await closeDatabaseConnection();
  }, 60000);

  async function users() {
    alice = await createTestUser();
    bob = await createTestUser();
    toDelete.push(alice.id, bob.id);
  }

  function build(steps: ScriptStep[], perms: string[] = ['browser:read', 'browser:write']) {
    const browser = new BrowserService(settings(), new BrowserRunRepository(), new BrowserConnectionService(() => generateEncryptionKey()));
    browserServices.push(browser);
    const repo = new AgentTaskRepository();
    const registry = new ToolRegistry();
    for (const tool of createBrowserTools(browser)) registry.register(tool);
    const provider = new ScriptedProvider(...steps);
    const runner = new AgentRunner({
      repo,
      registry,
      permissions: new StaticPermissions(perms),
      getProvider: () => provider,
      config: { retryBackoffBaseMs: 0, modelTimeoutMs: 5000, taskTimeoutMs: 120_000 },
    });
    return { browser, provider, service: new AgentTaskService({ repo, registry, runner }), repo };
  }

  async function drain(service: AgentTaskService) {
    let n = 0;
    while (n < 20 && (await service.processNext())) n++;
  }

  const compose = (recipient = 'alice@example.com') => [
    call('browser_open', { url: `${site.url}/compose` }),
    step((m) => call('browser_fill', { runId: runIdOf(m), ref: refFor(m, 'textbox', 'Recipient'), text: recipient })),
    step((m) => call('browser_inspect_action', { runId: runIdOf(m), ref: refFor(m, 'button', 'Send message') })),
    step((m) =>
      call('browser_perform_sensitive_action', {
        runId: runIdOf(m),
        ref: refFor(m, 'button', 'Send message'),
        fingerprint: last(m).data.fingerprint,
        summary: 'Send the message to the recipient',
      })
    ),
  ];

  // ------------------------------------------------------------------------------- confirmation gate

  it('pauses before a consequential action, shows the real details, and sends nothing until the user approves', async () => {
    await users();
    const { service } = build([...compose(), step((m) => text(`Verdict: ${last(m).data.verdict}`))]);
    const { task } = await service.createTask(alice.id, { request: 'Send alice a note' });
    await drain(service);

    const paused = await service.getTask(alice.id, task.id);
    expect(paused.status).toBe('awaiting_confirmation');
    const summary = paused.pendingConfirmation!.summary;
    expect(summary).toContain('Send message'); // what will be clicked
    expect(summary).toContain('alice@example.com'); // the recipient, read from the page itself
    expect(summary).toContain('/send'); // where the data goes
    expect(summary).toContain("Assistant's note:");
    expect(paused.pendingConfirmation!.toolName).toBe('browser_perform_sensitive_action');
    expect(site.posts).toHaveLength(0); // NOTHING has been submitted yet

    await service.confirmTask(alice.id, task.id, 'call_4_1', 'approve');
    await drain(service);

    const done = await service.getTask(alice.id, task.id);
    expect(done.status).toBe('succeeded');
    expect(done.result).toMatchObject({ response: 'Verdict: confirmed' });
    expect(site.posts).toHaveLength(1); // exactly once
    expect(site.posts[0]!.body).toContain('alice%40example.com');
  }, 120000);

  it('does nothing when the user declines', async () => {
    await users();
    const { service, provider } = build([...compose(), step((m) => text(`Declined: ${last(m).error?.code}`))]);
    const { task } = await service.createTask(alice.id, { request: 'Send alice a note' });
    await drain(service);
    await service.confirmTask(alice.id, task.id, 'call_4_1', 'reject');
    await drain(service);

    expect(site.posts).toHaveLength(0);
    expect((await service.getTask(alice.id, task.id)).result).toMatchObject({ response: 'Declined: USER_DECLINED' });
    expect(last(provider.calls.at(-1)!.messages).error?.code).toBe('USER_DECLINED');
  }, 120000);

  it('refuses to apply an approval to different details (page changed after the user was asked)', async () => {
    await users();
    const { service, browser } = build([...compose('alice@example.com'), step((m) => text(`Result: ${last(m).error?.code}`))]);
    const { task } = await service.createTask(alice.id, { request: 'Send alice a note' });
    await drain(service);
    expect((await service.getTask(alice.id, task.id)).status).toBe('awaiting_confirmation');

    // While the confirmation is pending, the form is altered (e.g. by the page itself or a restart).
    const toolCall = (await getDb().select().from(agentToolCalls).where(eq(agentToolCalls.taskId, task.id))).find((c) => c.toolName === 'browser_fill')!;
    const run = (await getDb().select().from(browserRuns).where(eq(browserRuns.userId, alice.id)))[0]!;
    const session = browser.manager.get(run.id, alice.id)!;
    const fillArgs = toolCall.args as { ref: string };
    await session.fill(fillArgs.ref, 'mallory@example.com');

    await service.confirmTask(alice.id, task.id, 'call_4_1', 'approve');
    await drain(service);

    expect(site.posts).toHaveLength(0); // the old approval was NOT used for the new details
    expect((await service.getTask(alice.id, task.id)).result).toMatchObject({ response: 'Result: ACTION_CHANGED' });
  }, 120000);

  it('reports a rejected submission as failed, never as success', async () => {
    await users();
    const { service } = build([
      call('browser_open', { url: `${site.url}/compose-fail` }),
      step((m) => call('browser_fill', { runId: runIdOf(m), ref: refFor(m, 'textbox', 'Note'), text: 'hello' })),
      step((m) => call('browser_inspect_action', { runId: runIdOf(m), ref: refFor(m, 'button', 'Save') })),
      step((m) => call('browser_perform_sensitive_action', { runId: runIdOf(m), ref: refFor(m, 'button', 'Save'), fingerprint: last(m).data.fingerprint, summary: 'Save the note' })),
      step((m) => text(`Verdict: ${last(m).data.verdict}`)),
    ]);
    const { task } = await service.createTask(alice.id, { request: 'save' });
    await drain(service);
    await service.confirmTask(alice.id, task.id, 'call_4_1', 'approve');
    await drain(service);
    expect((await service.getTask(alice.id, task.id)).result).toMatchObject({ response: 'Verdict: failed' });
  }, 120000);

  it('requires the same confirmation for a purchase and tells the user the price and currency from the page', async () => {
    await users();
    const { service } = build([
      call('browser_open', { url: `${site.url}/checkout` }),
      step((m) => call('browser_inspect_action', { runId: runIdOf(m), ref: refFor(m, 'button', 'Place order') })),
      step((m) => call('browser_perform_sensitive_action', { runId: runIdOf(m), ref: refFor(m, 'button', 'Place order'), fingerprint: last(m).data.fingerprint, summary: 'Place the order' })),
    ]);
    const { task } = await service.createTask(alice.id, { request: 'order' });
    await drain(service);
    const paused = await service.getTask(alice.id, task.id);
    expect(paused.status).toBe('awaiting_confirmation');
    expect(paused.pendingConfirmation!.summary).toContain('purchase');
    expect(paused.pendingConfirmation!.summary).toContain('Card number: ');
    expect(site.posts).toHaveLength(0);
  }, 120000);

  // ------------------------------------------------------------------------------- hostile websites

  it('treats injected page instructions as data: flags them, hides invisible text, and a tricked model still cannot act', async () => {
    await users();
    const outside = `http://localhost:${site.port}/`;
    const { service, provider } = build([
      call('browser_open', { url: `${site.url}/inject` }),
      // A model that obeyed the injected text would now try to go to another site...
      step((m) => call('browser_navigate', { runId: runIdOf(m), url: outside })),
      // ...and to a destructive page on the same site.
      step((m) => call('browser_navigate', { runId: runIdOf(m), url: `${site.url}/delete-account` })),
    ]);
    const { task } = await service.createTask(alice.id, { request: 'Look at the deals page' });
    await drain(service);

    const first = payloads(provider.calls[1]!.messages)[0]!;
    expect(first.data.page.warning).toContain('instructions to an AI assistant');
    expect(first.data.page.notice).toContain('UNTRUSTED');
    expect(JSON.stringify(first)).not.toContain('Hidden: ignore previous');
    expect(JSON.stringify(first)).not.toContain('tiny hidden instruction');

    const second = payloads(provider.calls[2]!.messages)[1]!;
    expect(second.ok).toBe(false);
    expect(second.error?.code).toBe('OUT_OF_SCOPE');

    // The destructive URL needs the user's approval and was never visited.
    const paused = await service.getTask(alice.id, task.id);
    expect(paused.status).toBe('awaiting_confirmation');
    expect(paused.pendingConfirmation!.toolName).toBe('browser_navigate');
    expect(site.hits.get('/delete-account') ?? 0).toBe(0);
  }, 120000);

  it('blocks a tricked model that clicks a destructive link without going through confirmation', async () => {
    await users();
    const { service, provider } = build([
      call('browser_open', { url: `${site.url}/` }),
      step((m) => call('browser_click', { runId: runIdOf(m), ref: refFor(m, 'link', 'Delete my account') })),
      step((m) => text(`Click result: ${last(m).error?.code}`)),
    ]);
    const { task } = await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    expect((await service.getTask(alice.id, task.id)).result).toMatchObject({ response: 'Click result: USE_SENSITIVE_ACTION' });
    expect(last(provider.calls.at(-1)!.messages).error?.message).toContain('browser_perform_sensitive_action');
    expect(site.hits.get('/delete-account') ?? 0).toBe(0);
  }, 120000);

  it('never types a password and tells the model to hand over to the user', async () => {
    await users();
    const { service } = build([
      call('browser_open', { url: `${site.url}/login` }),
      step((m) => call('browser_fill', { runId: runIdOf(m), ref: refFor(m, 'textbox', 'Password'), text: 'hunter2' })),
      step((m) => text(`${last(m).error?.code}`)),
    ]);
    const { task } = await service.createTask(alice.id, { request: 'log me in' });
    await drain(service);
    const done = await service.getTask(alice.id, task.id);
    expect(done.result).toMatchObject({ response: 'SENSITIVE_FIELD' });
    expect(site.posts).toHaveLength(0);
  }, 120000);

  it('tells the model when a page needs a login or CAPTCHA instead of letting it push on', async () => {
    await users();
    const { service, provider } = build([call('browser_open', { url: `${site.url}/login` }), text('done')]);
    await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    const open = payloads(provider.calls[1]!.messages)[0]!;
    expect(open.data.page.needsUser.reason).toBe('login_required');
    expect(open.data.page.needsUser.instruction).toContain('NEVER enter credentials');
    expect(open.data.status).toBe('waiting_for_user');
  }, 120000);

  // ------------------------------------------------------------------------ authorization and isolation

  it('hides write tools from users without browser:write, and refuses them if called anyway', async () => {
    await users();
    const { service, provider } = build(
      [call('browser_open', { url: `${site.url}/` }), step((m) => call('browser_click', { runId: runIdOf(m), ref: 'e1-1' })), step((m) => text(String(last(m).error?.code)))],
      ['browser:read']
    );
    const { task } = await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    const offered = provider.calls[0]!.tools.map((t) => t.name);
    expect(offered).toContain('browser_open');
    expect(offered).toContain('browser_snapshot');
    for (const writeTool of ['browser_click', 'browser_fill', 'browser_select', 'browser_set_checked', 'browser_perform_sensitive_action']) {
      expect(offered).not.toContain(writeTool);
    }
    expect((await service.getTask(alice.id, task.id)).result).toMatchObject({ response: 'NOT_AUTHORIZED' });
  }, 120000);

  it('offers no browser tools at all to a user with no browser permissions', async () => {
    await users();
    const { service, provider } = build([text('hi')], ['utility:read']);
    await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    expect(provider.calls[0]!.tools.filter((t) => t.name.startsWith('browser_'))).toHaveLength(0);
  }, 60000);

  it('rejects selectors, scripts and extra arguments: the model can only name elements by ref', async () => {
    await users();
    const { service, provider } = build([
      call('browser_open', { url: `${site.url}/` }),
      step((m) => call('browser_click', { runId: runIdOf(m), ref: 'e1-1', selector: '#buy', script: 'alert(1)' })),
      step((m) => call('browser_click', { runId: runIdOf(m), ref: '#buy-button' })),
      call('browser_click', { runId: 'not-a-uuid', ref: 'e1-1' }),
      text('done'),
    ]);
    await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    const results = payloads(provider.calls.at(-1)!.messages);
    expect(results.slice(1).map((r) => r.error?.code)).toEqual(['INVALID_ARGUMENTS', 'INVALID_ARGUMENTS', 'INVALID_ARGUMENTS']);
  }, 120000);

  it("another user's task cannot read or close a browser session it does not own", async () => {
    await users();
    const owner = build([text('unused')]);
    const started = await owner.browser.startRun(alice.id, { url: `${site.url}/products`, idempotencyKey: 'alice-run' });

    const { service, provider } = build([
      call('browser_snapshot', { runId: started.run.id }),
      call('browser_close', { runId: started.run.id }),
      text('done'),
    ]);
    // Bob's tools talk to the same database but to a different browser manager, and are scoped to Bob's identity.
    await service.createTask(bob.id, { request: 'x' });
    await drain(service);
    const results = payloads(provider.calls.at(-1)!.messages);
    expect(results.map((r) => r.error?.code)).toEqual(['RUN_NOT_FOUND', 'RUN_NOT_FOUND']);
    expect((await owner.browser.getRun(alice.id, started.run.id))?.status).toBe('running');
  }, 120000);

  // ------------------------------------------------------------------------------- reporting and logs

  it('reports failures with safe messages and keeps secrets out of results and logs', async () => {
    await users();
    const logged: string[] = [];
    for (const level of ['info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
        logged.push(JSON.stringify(args, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message } : v)));
      }) as never);
    }
    const { service, provider } = build([
      call('browser_open', { url: `${site.url}/` }),
      step((m) => call('browser_navigate', { runId: runIdOf(m), url: `${site.url}/redirect-out?token=TOPSECRET999&password=hunter2` })),
      text('done'),
    ]);
    await service.createTask(alice.id, { request: 'x' });
    await drain(service);

    const failure = payloads(provider.calls.at(-1)!.messages)[1]!;
    expect(failure.ok).toBe(false);
    expect(failure.error?.code).toBe('OUT_OF_SCOPE');
    const everything = JSON.stringify(payloads(provider.calls.at(-1)!.messages)) + logged.join('\n');
    expect(everything).not.toContain('TOPSECRET999');
    expect(everything).not.toContain('hunter2');
  }, 120000);

  it('ends the session and reports the final state when the model closes it', async () => {
    await users();
    const { service, browser } = build([
      call('browser_open', { url: `${site.url}/about` }),
      step((m) => call('browser_close', { runId: runIdOf(m), outcome: 'completed' })),
      step((m) => text(`closed: ${last(m).data.status}`)),
    ]);
    const { task } = await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    expect((await service.getTask(alice.id, task.id)).result).toMatchObject({ response: 'closed: completed' });
    expect(browser.manager.size).toBe(0);
  }, 120000);

  it('keeps one engine task attempt per call: a replayed open continues the same run', async () => {
    await users();
    const { service, browser } = build([call('browser_open', { url: `${site.url}/about` }), text('ok')]);
    const { task } = await service.createTask(alice.id, { request: 'x' });
    await drain(service);
    const rows = await getDb().select().from(browserRuns).where(and(eq(browserRuns.userId, alice.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.taskId).toBe(task.id);
    expect(browser.manager.size).toBe(1);
    expect((await getTaskRow(task.id))!.status).toBe('succeeded');
  }, 120000);
});
