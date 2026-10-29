import { and, eq } from 'drizzle-orm';
import { getDb } from '../../../db/client';
import { agentTasks, users, type BrowserHandoff } from '../../../db/schema';
import { getNotificationProvider } from '../../notifications';

/** Sends a plain message to the user on WhatsApp (through the existing notification service). */
export interface HandoffNotifier {
  send(userId: string, text: string, idempotencyKey: string): Promise<void>;
}

export class WhatsAppHandoffNotifier implements HandoffNotifier {
  async send(userId: string, text: string, idempotencyKey: string): Promise<void> {
    const [user] = await getDb().select({ phone: users.phoneNumber }).from(users).where(eq(users.id, userId)).limit(1);
    if (!user) throw new Error('user not found');
    // Handoff messages are sent right after the user messaged us, inside WhatsApp's 24-hour window, as free text.
    await getNotificationProvider().send({ to: user.phone, idempotencyKey, content: { kind: 'text', text } });
  }
}

/** Continues the paused work once the sign-in has been verified. */
export interface TaskResumer {
  /** Returns the id of the task created to continue, or null when there is nothing to resume. */
  resume(handoff: BrowserHandoff, host: string): Promise<string | null>;
}

/**
 * Resumes through the normal task lifecycle: a new agent task in the SAME conversation, created by the server only
 * after it verified the sign-in. Its text is built from trusted server state (site host and the run id the model
 * already knows). It never contains page content, so a website cannot influence what the agent is told to do.
 */
export class AgentTaskResumer implements TaskResumer {
  async resume(handoff: BrowserHandoff, host: string): Promise<string | null> {
    if (!handoff.taskId) return null;
    const [task] = await getDb()
      .select()
      .from(agentTasks)
      .where(and(eq(agentTasks.id, handoff.taskId), eq(agentTasks.userId, handoff.userId)))
      .limit(1);
    if (!task) return null;

    const session = handoff.runId
      ? ` The browser session ${handoff.runId} is ready again: continue with browser_snapshot on it, or browser_open ${host} if it has ended.`
      : ` Use browser_open on ${host}.`;
    const request =
      `(automatic) The user has finished signing in to ${host}; their sign-in is now connected and verified.` +
      ` Continue the request you were working on.${session} Never ask for credentials.`;

    // Imported lazily: the task service depends on the integrations, which depend on this module.
    const { getAgentTaskService } = await import('../../agent/engine/task-service');
    const { task: created } = await getAgentTaskService().createTask(handoff.userId, {
      request,
      conversationId: task.conversationId ?? undefined,
      idempotencyKey: `handoff-resume:${handoff.id}`,
      channel: task.channel === 'whatsapp' ? 'whatsapp' : 'api',
    });
    return created.id;
  }
}
