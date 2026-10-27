import { z } from 'zod';
import type { AgentTask } from '../../../db/schema';
import type { PendingConfirmation } from './task-repository';

export const TASK_TYPE_AGENT_REQUEST = 'agent_request';

/** Validated input for `agent_request` tasks. Persisted exactly as validated. */
export const agentRequestInputSchema = z.object({
  request: z.string().trim().min(1).max(20_000),
});

export type AgentRequestInput = z.infer<typeof agentRequestInputSchema>;

/** Public shape of a task. Deliberately omits transcript, lease and locking internals. */
export interface AgentTaskView {
  id: string;
  taskType: string;
  status: string;
  conversationId: string | null;
  input: unknown;
  attempts: number;
  maxAttempts: number;
  result: unknown;
  error: { code: string; message: string } | null;
  pendingConfirmation: PendingConfirmation | null;
  cancelRequested: boolean;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export function toTaskView(task: AgentTask): AgentTaskView {
  const result = (task.result ?? null) as { pendingConfirmation?: PendingConfirmation } | null;
  const pendingConfirmation =
    task.status === 'awaiting_confirmation' ? (result?.pendingConfirmation ?? null) : null;
  return {
    id: task.id,
    taskType: task.taskType,
    status: task.status,
    conversationId: task.conversationId,
    input: task.input,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    result: pendingConfirmation ? null : task.result,
    error: task.errorCode ? { code: task.errorCode, message: task.errorMessage ?? '' } : null,
    pendingConfirmation,
    cancelRequested: task.cancelRequestedAt !== null && task.status === 'running',
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    updatedAt: task.updatedAt,
  };
}
