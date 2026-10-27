import type { Logger } from 'pino';
import { getConfig } from '../../../config/env';
import { serializeToolFailure, serializeToolSuccess } from './sanitize';
import {
  AnyToolDefinition,
  ToolError,
  ToolExecutionContext,
  ToolOutcome,
  ToolTimeoutError,
  TransientToolError,
} from './types';

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/**
 * Runs one attempt with a hard deadline. The handler receives an AbortSignal that fires on
 * timeout or when the parent (task deadline / cancellation) aborts; handlers that ignore it are
 * abandoned, not killed, which is why non-idempotent timeouts are reported as outcome-unknown.
 */
async function runOnce(
  tool: AnyToolDefinition,
  input: unknown,
  ctx: Omit<ToolExecutionContext, 'signal'>,
  parent: AbortSignal
): Promise<unknown> {
  const controller = new AbortController();
  const onParentAbort = () => controller.abort(parent.reason);
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener('abort', onParentAbort, { once: true });

  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const err = new ToolTimeoutError(tool.timeoutMs);
        controller.abort(err);
        reject(err);
      }, tool.timeoutMs);
    });
    const aborted = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
    });
    return await Promise.race([tool.execute(input, { ...ctx, signal: controller.signal }), timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    parent.removeEventListener('abort', onParentAbort);
  }
}

/**
 * Executes a validated tool call under its timeout/retry policy and returns a sanitized,
 * model-safe outcome. Never throws for tool failures; only for task-level aborts.
 */
export async function executeTool(
  tool: AnyToolDefinition,
  input: unknown,
  ctx: Omit<ToolExecutionContext, 'signal'>,
  parentSignal: AbortSignal,
  log: Logger
): Promise<ToolOutcome> {
  const maxOutput = tool.maxOutputChars ?? getConfig().AGENT_MAX_TOOL_OUTPUT_CHARS;
  const retriesAllowed = tool.sideEffect === 'non_idempotent' ? 0 : tool.retry.maxRetries;

  for (let attempt = 0; ; attempt++) {
    try {
      const raw = await runOnce(tool, input, ctx, parentSignal);

      let output = raw;
      if (tool.outputSchema) {
        const parsed = tool.outputSchema.safeParse(raw);
        if (!parsed.success) {
          log.error({ tool: tool.name, issues: parsed.error.issues.length }, 'Tool output failed schema validation');
          return failure('TOOL_OUTPUT_INVALID', 'The tool returned an unexpected result.');
        }
        output = parsed.data;
      }
      const visible = tool.formatResult ? tool.formatResult(output) : output;
      return { ok: true, content: serializeToolSuccess(visible, maxOutput) };
    } catch (err) {
      if (parentSignal.aborted) throw parentSignal.reason ?? err;

      if (err instanceof ToolTimeoutError) {
        if (tool.sideEffect === 'non_idempotent') {
          log.warn({ tool: tool.name }, 'Non-idempotent tool timed out; outcome unknown');
          return {
            ...failure('OUTCOME_UNKNOWN', 'The action timed out and its outcome is unknown. Do not tell the user it succeeded.'),
            outcomeUnknown: true,
          };
        }
        if (attempt < retriesAllowed) {
          log.warn({ tool: tool.name, attempt: attempt + 1 }, 'Tool timed out; retrying');
          await sleep(tool.retry.backoffMs * 2 ** attempt, parentSignal);
          continue;
        }
        return failure('TOOL_TIMEOUT', 'The tool timed out.');
      }

      if (err instanceof TransientToolError && attempt < retriesAllowed) {
        log.warn({ tool: tool.name, errorCode: err.code, attempt: attempt + 1 }, 'Transient tool error; retrying');
        await sleep(tool.retry.backoffMs * 2 ** attempt, parentSignal);
        continue;
      }

      if (err instanceof ToolError) {
        return failure(err.code, err.message);
      }

      // Unexpected: keep details in logs, give the model nothing it could echo to the user.
      log.error({ err, tool: tool.name }, 'Tool handler threw an unexpected error');
      return failure('TOOL_EXECUTION_FAILED', 'The tool failed unexpectedly.');
    }
  }
}

function failure(code: string, message: string): Extract<ToolOutcome, { ok: false }> {
  return { ok: false, code, content: serializeToolFailure(code, message) };
}

export { failure as toolFailure };
