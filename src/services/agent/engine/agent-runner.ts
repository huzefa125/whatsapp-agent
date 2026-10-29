import type { Logger } from 'pino';
import { ZodError } from 'zod';
import { getConfig } from '../../../config/env';
import { AppError, ExternalServiceError, ForbiddenError, RateLimitError } from '../../../utils/errors';
import { logger } from '../../../utils/logger';
import { AgentTask } from '../../../db/schema';
import type { AiProvider, ToolCompletion, ToolSpec, ToolChatMessage } from '../../ai/types';
import { TOOL_USE_SYSTEM_PROMPT, formatUserMessageForModel } from '../prompts';
import { PermissionResolver, UserGrants } from './permissions';
import {
  sanitizeFinalResponse,
  scrubText,
  serializeToolFailure,
  truncate,
  wrapToolResultForModel,
} from './sanitize';
import { AgentTaskRepository, ClaimedTask, PendingConfirmation, StaleExecutionError } from './task-repository';
import { agentRequestInputSchema } from './task-types';
import { executeTool, toolFailure } from './tool-executor';
import { hasPermission, ToolRegistry } from './tool-registry';
import {
  countToolRounds,
  toProviderMessages,
  TranscriptMessage,
  transcriptSchema,
  unansweredToolCalls,
} from './transcript';
import type { AnyToolDefinition } from './types';

const MAX_RAW_ARGUMENT_CHARS = 8000;

export interface RunnerConfig {
  maxRounds: number;
  maxCallsPerRound: number;
  modelTimeoutMs: number;
  taskTimeoutMs: number;
  leaseMs: number;
  maxResponseChars: number;
  historyLimit: number;
  confirmationTtlMs: number;
  retryBackoffBaseMs: number;
}

export function runnerConfigFromEnv(): RunnerConfig {
  const c = getConfig();
  return {
    maxRounds: c.AGENT_MAX_TOOL_ROUNDS,
    maxCallsPerRound: c.AGENT_MAX_TOOL_CALLS_PER_ROUND,
    modelTimeoutMs: c.AGENT_MODEL_TIMEOUT_MS,
    taskTimeoutMs: c.AGENT_TASK_TIMEOUT_MS,
    leaseMs: c.AGENT_LEASE_SECONDS * 1000,
    maxResponseChars: c.AGENT_MAX_RESPONSE_CHARS,
    historyLimit: c.AGENT_HISTORY_LIMIT,
    confirmationTtlMs: c.AGENT_CONFIRMATION_TTL_MINUTES * 60_000,
    retryBackoffBaseMs: 2000,
  };
}

/** A failure with a stable code and a message that is safe to show the user. */
export class TaskFailure extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = 'TaskFailure';
  }
}

export class TaskCancelledError extends Error {
  constructor() {
    super('Task was cancelled');
    this.name = 'TaskCancelledError';
  }
}

export class ModelTimeoutError extends Error {
  constructor(ms: number) {
    super(`Model call timed out after ${ms}ms`);
    this.name = 'ModelTimeoutError';
  }
}

export interface RunnerDeps {
  repo: AgentTaskRepository;
  registry: ToolRegistry;
  permissions: PermissionResolver;
  getProvider: () => AiProvider;
  /** Extra per-user system-prompt text (e.g. timezone or workflow memories). Rebuilt on every model call. */
  systemContext?: (userId: string, task?: AgentTask) => Promise<string | null>;
  config?: Partial<RunnerConfig>;
}

interface RunContext {
  task: AgentTask;
  executionId: string;
  log: Logger;
  signal: AbortSignal;
  stats: { rounds: number; toolCalls: number; promptTokens: number; completionTokens: number; model: string | null };
}

type ToolStep = { kind: 'result'; message: TranscriptMessage } | { kind: 'paused' };
type LoopResult = { kind: 'final'; text: string } | { kind: 'paused' };

interface PendingCall {
  id: string;
  name: string;
  rawArguments: string;
  providerMetadata?: unknown;
}

const MAX_PROVIDER_METADATA_CHARS = 8192;

/** Opaque provider data (e.g. Gemini thought signatures) is kept only if small and serializable. */
function boundedProviderMetadata(value: unknown): { providerMetadata?: unknown } {
  if (value === undefined || value === null) return {};
  try {
    return JSON.stringify(value).length <= MAX_PROVIDER_METADATA_CHARS ? { providerMetadata: value } : {};
  } catch {
    return {};
  }
}

export class AgentRunner {
  private readonly cfg: RunnerConfig;

  constructor(private readonly deps: RunnerDeps) {
    this.cfg = { ...runnerConfigFromEnv(), ...deps.config };
  }

  /**
   * Drives one claimed task to a durable outcome (succeeded / failed / cancelled / retry scheduled /
   * awaiting confirmation). Never throws: every failure is converted into persisted task state.
   */
  async execute(claimed: ClaimedTask): Promise<void> {
    const { task, executionId, attemptNumber } = claimed;
    const log = logger.child({ taskId: task.id, executionId, userId: task.userId, attempt: attemptNumber });
    const abort = new AbortController();
    const deadline = setTimeout(
      () => abort.abort(new TaskFailure('TASK_TIMEOUT', 'The task took too long and was stopped.')),
      this.cfg.taskTimeoutMs
    );
    const ctx: RunContext = {
      task,
      executionId,
      log,
      signal: abort.signal,
      stats: { rounds: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, model: null },
    };

    log.info({ taskType: task.taskType }, 'Agent task execution started');
    try {
      const outcome = await this.loop(ctx);
      if (outcome.kind === 'final') {
        await this.deps.repo.succeed(
          task.id,
          executionId,
          { response: outcome.text, model: ctx.stats.model, rounds: ctx.stats.rounds },
          task.conversationId
            ? {
                conversationId: task.conversationId,
                userId: task.userId,
                content: outcome.text,
                metadata: { model: ctx.stats.model },
              }
            : null,
          this.attemptMetadata(ctx)
        );
        log.info({ ...this.attemptMetadata(ctx) }, 'Agent task succeeded');
      } else {
        log.info({ ...this.attemptMetadata(ctx) }, 'Agent task paused awaiting user confirmation');
      }
    } catch (err) {
      await this.handleFailure(ctx, err);
    } finally {
      clearTimeout(deadline);
    }
  }

  private attemptMetadata(ctx: RunContext): Record<string, unknown> {
    return { ...ctx.stats };
  }

  // ------------------------------------------------------------------------ main loop

  private async loop(ctx: RunContext): Promise<LoopResult> {
    const { task, executionId } = ctx;
    const { repo, registry } = this.deps;

    const input = agentRequestInputSchema.parse(task.input);
    // Permissions come from server-side state at execution time, never from the task input or model.
    const grants = await this.deps.permissions.resolve(task.userId);

    let transcript: TranscriptMessage[];
    if (task.transcript) {
      transcript = transcriptSchema.parse(task.transcript);
    } else {
      transcript = await this.buildInitialTranscript(task, input.request);
      await repo.checkpoint(task.id, executionId, transcript);
    }

    const specs = registry.specsFor(grants.permissions);
    const provider = this.deps.getProvider();

    for (;;) {
      await this.guard(ctx, this.cfg.modelTimeoutMs);

      // Resume point: tool calls from the last assistant turn that have no result yet
      // (fresh round, confirmation just resolved, or recovery after a crash).
      const pending = unansweredToolCalls(transcript);
      if (pending.length > 0) {
        for (const call of pending) {
          await this.guard(ctx);
          const step = await this.handleToolCall(ctx, call, grants, transcript);
          if (step.kind === 'paused') return { kind: 'paused' };
          transcript.push(step.message);
          await repo.checkpoint(task.id, executionId, transcript);
        }
        continue;
      }

      const rounds = countToolRounds(transcript);
      const extraContext = (await this.deps.systemContext?.(task.userId, task)) ?? null;
      const systemPrompt = extraContext ? `${TOOL_USE_SYSTEM_PROMPT}
${extraContext}` : TOOL_USE_SYSTEM_PROMPT;
      const completion = await this.callModel(ctx, provider, toProviderMessages(systemPrompt, transcript), specs);
      ctx.stats.model = completion.model;
      ctx.stats.promptTokens += completion.usage?.promptTokens ?? 0;
      ctx.stats.completionTokens += completion.usage?.completionTokens ?? 0;

      if (completion.kind === 'text') {
        const text = sanitizeFinalResponse(completion.content, this.cfg.maxResponseChars);
        if (!text) throw new TaskFailure('MODEL_EMPTY_RESPONSE', 'The AI returned an empty response.', true);
        return { kind: 'final', text };
      }
      if (completion.kind !== 'tool_calls' || !Array.isArray(completion.toolCalls) || completion.toolCalls.length === 0) {
        throw new TaskFailure('MODEL_MALFORMED_RESPONSE', 'The AI returned an unusable response.', true);
      }

      if (rounds >= this.cfg.maxRounds) {
        throw new TaskFailure(
          'MAX_TOOL_ROUNDS_EXCEEDED',
          'The assistant needed too many tool steps and was stopped.'
        );
      }
      if (completion.toolCalls.length > this.cfg.maxCallsPerRound) {
        throw new TaskFailure('TOO_MANY_TOOL_CALLS', 'The assistant requested too many tool calls at once.');
      }

      const round = rounds + 1;
      const calls: PendingCall[] = completion.toolCalls.map((tc, i) => ({
        // Engine-assigned IDs: provider IDs may be empty, duplicated or attacker-influenced.
        id: `call_${round}_${i + 1}`,
        name: truncate(String(tc.name ?? ''), 128),
        rawArguments:
          typeof tc.rawArguments === 'string' && tc.rawArguments.length <= MAX_RAW_ARGUMENT_CHARS
            ? tc.rawArguments
            : '__invalid__',
        ...boundedProviderMetadata(tc.providerMetadata),
      }));
      transcript.push({
        role: 'assistant',
        content: completion.content ? truncate(scrubText(completion.content), 2000) : null,
        toolCalls: calls,
      });
      ctx.stats.rounds = round;
      await repo.checkpoint(task.id, executionId, transcript);
    }
  }

  private async buildInitialTranscript(task: AgentTask, request: string): Promise<TranscriptMessage[]> {
    const out: TranscriptMessage[] = [];
    if (task.conversationId) {
      // Ownership is re-checked by scoping on task.userId; history is never read by conversation ID alone.
      const history = await this.deps.repo.loadConversationHistory(
        task.userId,
        task.conversationId,
        task.createdAt,
        task.id,
        this.cfg.historyLimit
      );
      for (const row of history) {
        if (row.role === 'user') out.push({ role: 'user', content: formatUserMessageForModel(row.content) });
        else if (row.role === 'assistant') out.push({ role: 'assistant', content: row.content });
      }
    }
    out.push({ role: 'user', content: formatUserMessageForModel(request) });
    return out;
  }

  /** Cancellation, deadline and lease check; also extends the lease. */
  private async guard(ctx: RunContext, stepTimeoutMs = 0): Promise<void> {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    const hb = await this.deps.repo.heartbeat(ctx.task.id, ctx.executionId, this.cfg.leaseMs + stepTimeoutMs);
    if (!hb) throw new StaleExecutionError();
    if (hb.cancelRequested) throw new TaskCancelledError();
  }

  private async callModel(
    ctx: RunContext,
    provider: AiProvider,
    messages: ToolChatMessage[],
    tools: ToolSpec[]
  ): Promise<ToolCompletion> {
    if (!provider.generateWithTools) {
      throw new TaskFailure('AI_TOOLS_UNSUPPORTED', 'The configured AI provider does not support tool calling.');
    }
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ModelTimeoutError(this.cfg.modelTimeoutMs)), this.cfg.modelTimeoutMs);
      });
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(ctx.signal.reason);
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      });
      return await Promise.race([provider.generateWithTools(messages, tools), timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  // ------------------------------------------------------------------------ tool calls

  private async handleToolCall(
    ctx: RunContext,
    call: PendingCall,
    grants: UserGrants,
    transcript: TranscriptMessage[]
  ): Promise<ToolStep> {
    const { task } = ctx;
    const { repo, registry } = this.deps;
    const log = ctx.log.child({ callId: call.id, tool: call.name });
    const reply = (content: string): ToolStep => ({
      kind: 'result',
      message: { role: 'tool', toolCallId: call.id, name: call.name, content: wrapToolResultForModel(call.name, content) },
    });
    const reject = async (code: string, message: string, args: unknown = {}): Promise<ToolStep> => {
      const content = serializeToolFailure(code, message);
      await repo.insertToolCall({
        taskId: task.id,
        callId: call.id,
        toolName: call.name,
        args,
        status: 'failed',
        result: content,
        errorCode: code,
      });
      return reply(content);
    };

    const existing = await repo.getToolCall(task.id, call.id);

    if (existing) {
      switch (existing.status) {
        case 'succeeded':
        case 'failed':
          // Recorded outcome wins; a side effect is never executed twice for the same call.
          return reply(
            typeof existing.result === 'string'
              ? existing.result
              : serializeToolFailure(existing.errorCode ?? 'TOOL_EXECUTION_FAILED', 'The tool failed.')
          );
        case 'rejected':
          return reply(serializeToolFailure('USER_DECLINED', 'The user declined this action. It was not performed.'));
        case 'awaiting_confirmation': {
          const tool = registry.get(existing.toolName);
          if (!tool) return reply(serializeToolFailure('TOOL_NOT_FOUND', 'This tool is no longer available.'));
          return this.pause(ctx, tool, call, existing.args, transcript);
        }
        case 'running': {
          const tool = registry.get(existing.toolName);
          if (!tool || tool.sideEffect === 'non_idempotent') {
            await repo.transitionToolCall(task.id, call.id, ['running'], 'failed', {
              result: serializeToolFailure('OUTCOME_UNKNOWN', 'The action was interrupted and its outcome is unknown.'),
              errorCode: 'OUTCOME_UNKNOWN',
            });
            throw new TaskFailure(
              'OUTCOME_UNKNOWN',
              'An action was interrupted and its outcome could not be determined, so it was not retried. Please check and try again.'
            );
          }
          // Safe to re-run (read-only, or idempotent with a stable key).
          return this.runLedgered(ctx, tool, existing.args, call, grants, 'resume');
        }
        case 'approved': {
          const tool = registry.get(existing.toolName);
          if (!tool) return reply(serializeToolFailure('TOOL_NOT_FOUND', 'This tool is no longer available.'));
          return this.runLedgered(ctx, tool, existing.args, call, grants, 'approved');
        }
      }
    }

    // ---- brand new call: everything below treats the model output as hostile.
    const tool = registry.get(call.name);
    if (!tool) {
      log.warn('Model requested an unknown tool');
      return reject('TOOL_NOT_FOUND', 'No such tool is available.');
    }

    let rawJson: unknown;
    try {
      rawJson = call.rawArguments.trim() === '' ? {} : JSON.parse(call.rawArguments);
    } catch {
      return reject('INVALID_ARGUMENTS', 'Arguments must be a valid JSON object.');
    }
    if (rawJson === null || typeof rawJson !== 'object' || Array.isArray(rawJson)) {
      return reject('INVALID_ARGUMENTS', 'Arguments must be a JSON object.');
    }
    const parsed = tool.inputSchema.safeParse(rawJson);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`)
        .join('; ');
      return reject('INVALID_ARGUMENTS', `Invalid arguments. ${issues}`);
    }

    // Authorization is decided here, from server-side grants, independent of anything the model said.
    if (!tool.permissions.every((p) => hasPermission(grants.permissions, p))) {
      log.warn({ required: tool.permissions }, 'Tool call denied: user lacks required permission');
      return reject('NOT_AUTHORIZED', 'You do not have permission to use this tool.');
    }

    const needsConfirmation =
      tool.requiresConfirmation || (tool.shouldConfirm ? await tool.shouldConfirm(parsed.data, { userId: task.userId }) : false);
    if (needsConfirmation) {
      const created = await repo.insertToolCall({
        taskId: task.id,
        callId: call.id,
        toolName: tool.name,
        args: parsed.data,
        status: 'awaiting_confirmation',
      });
      if (!created) throw new StaleExecutionError();
      return this.pause(ctx, tool, call, parsed.data, transcript);
    }

    const created = await repo.insertToolCall({
      taskId: task.id,
      callId: call.id,
      toolName: tool.name,
      args: parsed.data,
      status: 'running',
    });
    if (!created) throw new StaleExecutionError();
    return this.runLedgered(ctx, tool, parsed.data, call, grants, 'new');
  }

  /**
   * Executes a call whose ledger row already exists. Entering `running` is a compare-and-set,
   * so two executions can never both run the same call.
   */
  private async runLedgered(
    ctx: RunContext,
    tool: AnyToolDefinition,
    storedArgs: unknown,
    call: PendingCall,
    grants: UserGrants,
    mode: 'new' | 'approved' | 'resume'
  ): Promise<ToolStep> {
    const { task } = ctx;
    const { repo } = this.deps;
    const log = ctx.log.child({ callId: call.id, tool: tool.name });
    const reply = (content: string): ToolStep => ({
      kind: 'result',
      message: { role: 'tool', toolCallId: call.id, name: call.name, content: wrapToolResultForModel(call.name, content) },
    });

    // Stored args are re-validated: the schema or permissions may have changed since they were saved.
    const parsed = tool.inputSchema.safeParse(storedArgs);
    const authorized = tool.permissions.every((p) => hasPermission(grants.permissions, p));
    if (!parsed.success || !authorized) {
      const failed = !parsed.success
        ? toolFailure('INVALID_ARGUMENTS', 'Stored arguments are no longer valid.')
        : toolFailure('NOT_AUTHORIZED', 'You do not have permission to use this tool.');
      await repo.transitionToolCall(task.id, call.id, ['approved', 'running'], 'failed', {
        result: failed.content,
        errorCode: failed.ok ? null : failed.code,
      });
      return reply(failed.content);
    }

    if (mode === 'approved') {
      const entered = await repo.transitionToolCall(task.id, call.id, ['approved'], 'running');
      if (!entered) throw new StaleExecutionError();
    }

    await this.guard(ctx, tool.timeoutMs * (1 + tool.retry.maxRetries));
    ctx.stats.toolCalls++;
    log.info({ mode }, 'Executing tool');
    const outcome = await executeTool(
      tool,
      parsed.data,
      {
        userId: task.userId,
        taskId: task.id,
        executionId: ctx.executionId,
        toolCallId: call.id,
        idempotencyKey: `${task.id}:${call.id}`,
        log,
      },
      ctx.signal,
      log
    );

    await repo.transitionToolCall(task.id, call.id, ['running'], outcome.ok ? 'succeeded' : 'failed', {
      result: outcome.content,
      errorCode: outcome.ok ? null : outcome.code,
    });
    log.info({ ok: outcome.ok, ...(outcome.ok ? {} : { errorCode: outcome.code }) }, 'Tool finished');
    return reply(outcome.content);
  }

  private async pause(
    ctx: RunContext,
    tool: AnyToolDefinition,
    call: PendingCall,
    args: unknown,
    transcript: TranscriptMessage[]
  ): Promise<ToolStep> {
    let summary = tool.name;
    try {
      const parsed = tool.inputSchema.safeParse(args);
      if (tool.describeCall && parsed.success) summary = await tool.describeCall(parsed.data, { userId: ctx.task.userId });
    } catch {
      summary = tool.name;
    }
    const argsJson = JSON.stringify(args ?? {});
    const pending: PendingConfirmation = {
      callId: call.id,
      toolName: tool.name,
      summary: truncate(scrubText(summary), 800),
      arguments: argsJson.length <= 2000 ? JSON.parse(scrubText(argsJson)) : { truncated: true },
    };
    await this.deps.repo.pauseForConfirmation(
      ctx.task.id,
      ctx.executionId,
      transcript,
      this.cfg.confirmationTtlMs,
      pending,
      this.attemptMetadata(ctx)
    );
    return { kind: 'paused' };
  }

  // ------------------------------------------------------------------------ failure handling

  private classify(err: unknown): { code: string; message: string; retryable: boolean } {
    if (err instanceof TaskFailure) return { code: err.code, message: err.message, retryable: err.retryable };
    if (err instanceof RateLimitError) {
      return { code: 'AI_RATE_LIMITED', message: 'The AI service is busy right now.', retryable: true };
    }
    if (err instanceof ModelTimeoutError) {
      return { code: 'AI_TIMEOUT', message: 'The AI service took too long to respond.', retryable: true };
    }
    if (err instanceof ExternalServiceError) {
      return { code: 'AI_PROVIDER_ERROR', message: 'The AI service is temporarily unavailable.', retryable: true };
    }
    if (err instanceof AppError && (err.code === 'AI_AUTH_FAILED' || err.code === 'AI_CONFIG_ERROR')) {
      return { code: 'AI_PROVIDER_UNAVAILABLE', message: 'The AI service is not configured correctly.', retryable: false };
    }
    if (err instanceof ForbiddenError) {
      return { code: 'NOT_AUTHORIZED', message: 'You are not allowed to run this task.', retryable: false };
    }
    if (err instanceof ZodError) {
      return { code: 'TASK_STATE_INVALID', message: 'The task data is invalid.', retryable: false };
    }
    return { code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: false };
  }

  private async handleFailure(ctx: RunContext, err: unknown): Promise<void> {
    const { task, executionId, log } = ctx;
    const { repo } = this.deps;
    try {
      if (err instanceof StaleExecutionError) {
        log.warn('Execution lease lost; abandoning without writing state');
        return;
      }
      if (err instanceof TaskCancelledError) {
        await repo.markCancelled(task.id, executionId, this.attemptMetadata(ctx));
        log.info('Agent task cancelled');
        return;
      }

      const info = this.classify(err);
      if (info.code === 'INTERNAL_ERROR' || info.code === 'TASK_STATE_INVALID') {
        log.error({ err }, 'Agent task hit an unexpected error');
      }

      if (info.retryable && task.attempts < task.maxAttempts) {
        let delay = Math.min(60_000, this.cfg.retryBackoffBaseMs * 4 ** (task.attempts - 1));
        if (info.code === 'AI_RATE_LIMITED') {
          // Provider quotas reset per minute (or per day), so retrying within seconds only burns attempts.
          delay = Math.max(delay, this.cfg.retryBackoffBaseMs * 15 * task.attempts);
        }
        const outcome = await repo.scheduleRetry(
          task.id,
          executionId,
          delay,
          info.code,
          info.message,
          this.attemptMetadata(ctx)
        );
        log.warn({ errorCode: info.code, delayMs: delay, outcome }, 'Agent task attempt failed; retry scheduled');
      } else {
        await repo.fail(task.id, executionId, info.code, info.message, this.attemptMetadata(ctx));
        log.warn({ errorCode: info.code }, 'Agent task failed');
      }
    } catch (persistErr) {
      if (persistErr instanceof StaleExecutionError) {
        log.warn('Execution lease lost while recording failure');
      } else {
        // Lease expiry + recoverStale() will requeue it; nothing else is safe to do here.
        log.error({ err: persistErr }, 'Could not persist task failure; relying on lease recovery');
      }
    }
  }
}
