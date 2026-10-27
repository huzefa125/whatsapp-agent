export const TASK_STATUSES = [
  'pending',
  'running',
  'awaiting_confirmation',
  'succeeded',
  'failed',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_STATUSES: readonly TaskStatus[] = ['succeeded', 'failed', 'cancelled'];

/**
 * pending ──claim──▶ running ──▶ succeeded | failed | cancelled
 *    ▲                 │ ├────▶ pending               (transient failure, lease recovery)
 *    │                 │ └────▶ awaiting_confirmation (tool needs user approval)
 *    └─────────────────┴── awaiting_confirmation ──▶ pending (approved/rejected) | cancelled | failed
 */
const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  pending: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled', 'pending', 'awaiting_confirmation'],
  awaiting_confirmation: ['pending', 'cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus
  ) {
    super(`Invalid task transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}
