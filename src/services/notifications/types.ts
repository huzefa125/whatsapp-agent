export type NotificationContent =
  | { kind: 'text'; text: string }
  | { kind: 'template'; name: string; language: string; bodyParameters: string[] };

export interface NotificationRequest {
  /** Recipient phone number (E.164). */
  to: string;
  /** Stable per logical notification. Providers that support idempotency must honour it. */
  idempotencyKey: string;
  content: NotificationContent;
}

/** The provider ACCEPTED the request. This is not proof of delivery. */
export interface NotificationReceipt {
  provider: 'whatsapp' | 'mock';
  providerMessageId: string;
  acceptedAt: Date;
}

export type NotificationFailureKind = 'retryable' | 'permanent';

/** Provider failure, already classified so the scheduler never has to inspect provider internals. */
export class NotificationError extends Error {
  constructor(
    public readonly kind: NotificationFailureKind,
    public readonly code: string,
    /** Sanitized, safe to store and show. Never contains message content or credentials. */
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = 'NotificationError';
  }
}

export interface NotificationProvider {
  readonly name: 'whatsapp' | 'mock';
  send(request: NotificationRequest): Promise<NotificationReceipt>;
}
