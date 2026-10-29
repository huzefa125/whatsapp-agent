import { createHash } from 'crypto';
import { getConfig } from '../../../config/env';
import { BadRequestError, ConflictError, NotFoundError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { getAiProvider } from '../../ai';
import { AgentRunner } from './agent-runner';
import { DefaultPermissionResolver, PermissionResolver } from './permissions';
import { AgentTaskRepository } from './task-repository';
import { TaskStatus } from './task-state';
import {
  agentRequestInputSchema,
  AgentTaskView,
  TASK_TYPE_AGENT_REQUEST,
  toTaskView,
} from './task-types';
import { calculatorTool } from './tools/calculator';
import { ToolRegistry } from './tool-registry';
import { getReminderService, ReminderService } from '../../reminders/reminder-service';
import { createReminderTools } from '../../reminders/reminder-tools';
import { getIntegrations } from '../../integrations';
import { getMemoryService, MemoryService, createMemoryTools } from '../../memory';

export interface CreateTaskRequest {
  request: string;
  conversationId?: string | undefined;
  idempotencyKey?: string | undefined;
  channel?: 'api' | 'whatsapp' | undefined;
  /** wamid of the inbound WhatsApp message that produced this request. */
  providerMessageId?: string | undefined;
}

export interface TaskServiceDeps {
  repo?: AgentTaskRepository;
  runner?: AgentRunner;
  registry?: ToolRegistry;
  permissions?: PermissionResolver;
  reminders?: ReminderService;
  memory?: MemoryService;
}

/** Built-in tools: calculator, reminders, memory, plus the tools of every enabled integration. */
export function createDefaultToolRegistry(
  reminders: ReminderService = getReminderService(),
  memory: MemoryService = getMemoryService()
): ToolRegistry {
  const registry = new ToolRegistry().register(calculatorTool);
  for (const tool of createReminderTools(reminders)) registry.register(tool);
  for (const tool of createMemoryTools(memory)) registry.register(tool);
  // Integrations (the browser fallback today; official API providers in later phases) contribute their own tools.
  for (const tool of getIntegrations().allTools()) registry.register(tool);
  return registry;
}

export class AgentTaskService {
  readonly repo: AgentTaskRepository;
  readonly registry: ToolRegistry;
  private readonly runner: AgentRunner;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  private lastRecovery = 0;

  constructor(deps: TaskServiceDeps = {}) {
    this.repo = deps.repo ?? new AgentTaskRepository();
    const reminders = deps.reminders ?? getReminderService();
    const memory = deps.memory ?? getMemoryService();
    this.registry = deps.registry ?? createDefaultToolRegistry(reminders, memory);
    this.runner =
      deps.runner ??
      new AgentRunner({
        repo: this.repo,
        registry: this.registry,
        permissions: deps.permissions ?? new DefaultPermissionResolver(),
        getProvider: getAiProvider,
        systemContext: async (userId, task) => {
          const reqText = (task?.input as { request?: string } | undefined)?.request;
          const [reminderCtx, memoryCtx] = await Promise.all([
            reminders.buildAgentContext(userId),
            memory.buildAgentContext(userId, reqText),
          ]);
          return [reminderCtx, memoryCtx].filter(Boolean).join('\n\n');
        },
      });
  }

  // ------------------------------------------------------------------ API operations
  // `userId` must always come from verified authentication (req.user.id), never from a request field.

  async createTask(
    userId: string,
    req: CreateTaskRequest
  ): Promise<{ task: AgentTaskView; created: boolean }> {
    const config = getConfig();
    const input = agentRequestInputSchema.parse({ request: req.request });
    if (input.request.length > config.AGENT_MAX_REQUEST_CHARS) {
      throw new BadRequestError(`request must be at most ${config.AGENT_MAX_REQUEST_CHARS} characters`);
    }

    const { task, created } = await this.repo.createTask({
      userId,
      conversationId: req.conversationId ?? null,
      taskType: TASK_TYPE_AGENT_REQUEST,
      input,
      idempotencyKey: req.idempotencyKey ?? null,
      maxAttempts: config.AGENT_MAX_ATTEMPTS,
      userMessage: req.conversationId ? input.request : null,
      channel: req.channel ?? 'api',
      userMessageProviderId: req.providerMessageId ?? null,
    });

    if (!created) {
      // Same key must mean the same request; otherwise the client has a bug we should surface.
      const same =
        digest(task.input) === digest(input) && (task.conversationId ?? null) === (req.conversationId ?? null);
      if (!same) throw new ConflictError('Idempotency key was already used with a different request');
    } else {
      logger.info({ taskId: task.id, userId }, 'Agent task created');
    }
    return { task: toTaskView(task), created };
  }

  async getTask(userId: string, taskId: string): Promise<AgentTaskView> {
    const task = await this.repo.getTaskForUser(userId, taskId);
    if (!task) throw new NotFoundError('Task not found');
    return toTaskView(task);
  }

  async listTasks(
    userId: string,
    opts: { status?: TaskStatus | undefined; limit: number; offset: number }
  ): Promise<AgentTaskView[]> {
    const rows = await this.repo.listTasksForUser(userId, {
      limit: opts.limit,
      offset: opts.offset,
      ...(opts.status ? { status: opts.status } : {}),
    });
    return rows.map(toTaskView);
  }

  async cancelTask(userId: string, taskId: string): Promise<AgentTaskView> {
    const task = await this.repo.requestCancel(userId, taskId);
    logger.info({ taskId, userId, status: task.status }, 'Agent task cancel requested');
    return toTaskView(task);
  }

  async confirmTask(
    userId: string,
    taskId: string,
    callId: string,
    decision: 'approve' | 'reject'
  ): Promise<AgentTaskView> {
    const task = await this.repo.resolveConfirmation(userId, taskId, callId, decision);
    logger.info({ taskId, userId, callId, decision }, 'Agent task confirmation recorded');
    return toTaskView(task);
  }

  // ------------------------------------------------------------------ worker

  /** Claims and fully executes one task. Returns false when nothing was runnable. */
  async processNext(): Promise<boolean> {
    const config = getConfig();
    const claimed = await this.repo.claimNext(config.AGENT_LEASE_SECONDS * 1000);
    if (!claimed) return false;
    await this.runner.execute(claimed);
    return true;
  }

  async recover(): Promise<ReturnType<AgentTaskRepository['recoverStale']>> {
    const stats = await this.repo.recoverStale();
    if (stats.requeued || stats.failed || stats.cancelled || stats.expired) {
      logger.warn(stats, 'Recovered stale agent tasks');
    }
    return stats;
  }

  startWorker(): void {
    if (this.timer) return;
    const config = getConfig();
    const pollMs = config.AGENT_POLL_INTERVAL_MS;
    logger.info({ pollMs }, 'Starting agent task worker');

    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.tick().finally(() => {
        this.inFlight = null;
      });
    }, pollMs);
  }

  private async tick(): Promise<void> {
    try {
      // Recovery is cheap but needn't run on every poll.
      if (Date.now() - this.lastRecovery > 15_000) {
        this.lastRecovery = Date.now();
        await this.recover();
      }
      while (this.timer && (await this.processNext())) {
        /* drain */
      }
    } catch (err) {
      logger.error({ err }, 'Agent worker iteration failed');
    }
  }

  /** Stops polling and waits (bounded) for the in-flight task so shutdown does not strand it. */
  async stopWorker(waitMs = 8000): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Agent task worker stopping');
    }
    if (this.inFlight) {
      await Promise.race([this.inFlight, new Promise((resolve) => setTimeout(resolve, waitMs))]);
    }
  }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

let activeService: AgentTaskService | null = null;

export function getAgentTaskService(): AgentTaskService {
  if (!activeService) activeService = new AgentTaskService();
  return activeService;
}

export function setAgentTaskServiceForTesting(service: AgentTaskService | null): void {
  activeService = service;
}
