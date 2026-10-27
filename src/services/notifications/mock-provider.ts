import { randomUUID } from 'crypto';
import { logger } from '../../utils/logger';
import { NotificationProvider, NotificationReceipt, NotificationRequest } from './types';

export interface MockSend {
  request: NotificationRequest;
  receipt: NotificationReceipt;
}

/**
 * Development/test provider. It NEVER contacts WhatsApp: a "delivered" mock reminder reached nobody.
 * Receipts are tagged provider='mock' and message IDs start with "mock:" so they can never be
 * mistaken for real deliveries. Honours idempotencyKey (like a provider that supports it).
 */
export class MockNotificationProvider implements NotificationProvider {
  readonly name = 'mock' as const;
  readonly sent: MockSend[] = [];
  private readonly byKey = new Map<string, NotificationReceipt>();
  private script: Array<Error | 'ok' | (() => Promise<void>)> = [];

  /** Queue outcomes for the next send() calls: an Error to throw, 'ok', or an async hook. */
  enqueue(...steps: Array<Error | 'ok' | (() => Promise<void>)>): this {
    this.script.push(...steps);
    return this;
  }

  async send(request: NotificationRequest): Promise<NotificationReceipt> {
    const step = this.script.shift();
    if (step instanceof Error) throw step;
    if (typeof step === 'function') await step();

    const existing = this.byKey.get(request.idempotencyKey);
    if (existing) return existing;

    const receipt: NotificationReceipt = {
      provider: 'mock',
      providerMessageId: `mock:${randomUUID()}`,
      acceptedAt: new Date(),
    };
    this.byKey.set(request.idempotencyKey, receipt);
    this.sent.push({ request, receipt });
    logger.warn(
      { idempotencyKey: request.idempotencyKey, contentKind: request.content.kind },
      'MOCK notification provider: message recorded locally and NOT sent to WhatsApp'
    );
    return receipt;
  }
}
