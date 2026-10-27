import type { z } from 'zod';
import type { Logger } from 'pino';

/**
 * How a tool affects the outside world. Drives retry and crash-recovery behaviour:
 * - none:           read-only; always safe to re-run.
 * - idempotent:     writes, but repeating the same call with the same idempotencyKey is safe.
 * - non_idempotent: repeating may duplicate the effect; never retried, never auto-replayed.
 */
export type SideEffect = 'none' | 'idempotent' | 'non_idempotent';

export interface ToolRetryPolicy {
  /** Extra attempts after the first. Forced to 0 for non_idempotent tools. */
  maxRetries: number;
  /** Base delay; doubled for every retry. */
  backoffMs: number;
}

export interface ToolExecutionContext {
  userId: string;
  taskId: string;
  /** Correlation ID of the current execution attempt (also the lease fencing token). */
  executionId: string;
  toolCallId: string;
  /** Stable per tool call. Pass to external APIs so retries/replays do not duplicate side effects. */
  idempotencyKey: string;
  /** Aborted on timeout, cancellation or task deadline. Handlers should honour it. */
  signal: AbortSignal;
  log: Logger;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> {
  /** Stable, snake_case. Changing it breaks persisted transcripts. */
  name: string;
  /** Shown to the model. Describe what the tool does and when to use it. */
  description: string;
  inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>;
  /** When set, handler output is validated against it before it reaches the model. */
  outputSchema?: z.ZodType<TOutput, z.ZodTypeDef, unknown>;
  /** The user must hold ALL of these permissions. Checked by the engine, never by the model. */
  permissions: readonly string[];
  sideEffect: SideEffect;
  /** Required for non_idempotent tools; recommended for any sensitive action. */
  requiresConfirmation: boolean;
  timeoutMs: number;
  retry: ToolRetryPolicy;
  /** Per-tool cap on the serialized result. Defaults to AGENT_MAX_TOOL_OUTPUT_CHARS. */
  maxOutputChars?: number;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<TOutput>;
  /** Maps handler output to the (smaller) shape the model may see. Defaults to the raw output. */
  formatResult?(output: TOutput): unknown;
  /** One-line, non-sensitive description of a pending call, shown to the user for confirmation. */
  describeCall?(input: TInput): string;
}

/** Type-erased definition as stored in the registry. */
export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

export type ToolOutcome =
  | { ok: true; content: string }
  | { ok: false; code: string; content: string; outcomeUnknown?: boolean };

/** Raised by tool handlers for expected failures. The message is shown to the model. */
export class ToolError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

/** Raised by tool handlers for transient failures that may be retried (if the tool allows). */
export class TransientToolError extends ToolError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'TransientToolError';
  }
}

export class ToolTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Tool timed out after ${timeoutMs}ms`);
    this.name = 'ToolTimeoutError';
  }
}
