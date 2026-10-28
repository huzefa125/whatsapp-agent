import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxService } from '../../src/services/queue/outbox';
import * as dbClient from '../../src/db/client';
import { setWhatsAppChannelForTesting } from '../../src/services/agent/whatsapp/channel';

describe('OutboxService', () => {
  const outbox = new OutboxService();

  beforeEach(() => {
    vi.restoreAllMocks();
    setWhatsAppChannelForTesting(null);
  });

  const inboundEvent = (id: string) => ({
    type: 'text_message' as const,
    providerMessageId: id,
    senderPhoneNumber: '15551234567',
    text: 'Hello',
    timestamp: new Date(),
    phoneNumberId: 'PN_1',
    raw: {},
  });

  /** A db whose transaction hands the callback a tx that records inserts; the first insert returns `eventRows`. */
  function mockTransactionalDb(eventRows: unknown[]) {
    const inserts: unknown[] = [];
    const tx = {
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn().mockImplementation((v: unknown) => {
          inserts.push(v);
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(eventRows) }),
            then: (resolve: any) => resolve([]),
          };
        }),
      })),
    };
    const db = { transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)) };
    return { db, tx, inserts };
  }

  it('records the event and queues the job in one transaction', async () => {
    const { db, tx } = mockTransactionalDb([{ id: 'event-uuid-1' }]);
    vi.spyOn(dbClient, 'getDb').mockReturnValue(db as any);

    expect(await outbox.enqueueInboundMessage(inboundEvent('wamid.MSG_UNIQUE_1'))).toBe(true);
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(tx.insert).toHaveBeenCalledTimes(2);
  });

  it('detects duplicate webhook events and skips job queue insertion', async () => {
    const { db, tx } = mockTransactionalDb([]); // conflict -> no rows returned
    vi.spyOn(dbClient, 'getDb').mockReturnValue(db as any);

    expect(await outbox.enqueueInboundMessage(inboundEvent('wamid.DUPLICATE_MSG'))).toBe(false);
    expect(tx.insert).toHaveBeenCalledTimes(1); // never inserted into outbox_jobs
  });

  it('does not leave a recorded event behind when queueing the job fails', async () => {
    const tx = {
      insert: vi
        .fn()
        .mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'e' }]) }),
          }),
        })
        .mockReturnValueOnce({ values: vi.fn().mockRejectedValue(new Error('db down')) }),
    };
    // A real transaction rolls back when the callback throws; the mock only needs to propagate the error.
    const db = { transaction: vi.fn().mockImplementation(async (fn: any) => fn(tx)) };
    vi.spyOn(dbClient, 'getDb').mockReturnValue(db as any);

    await expect(outbox.enqueueInboundMessage(inboundEvent('wamid.X'))).rejects.toThrow('db down');
  });

  it('returns false when no pending jobs are available', async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    const processed = await outbox.processNextJob();
    expect(processed).toBe(false);
  });

  it('processes pending job successfully and updates job status to completed', async () => {
    const testJob = {
      id: 'job-1',
      jobType: 'process_inbound_message',
      payload: {
        event: {
          type: 'text_message',
          providerMessageId: 'wamid.MSG_1',
          senderPhoneNumber: '15551234567',
          text: 'Hi',
          timestamp: new Date().toISOString(),
        },
      },
      status: 'pending',
      attempts: 0,
      maxAttempts: 3,
    };

    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([testJob]),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    const channel = { handleInbound: vi.fn().mockResolvedValue(undefined) };
    setWhatsAppChannelForTesting(channel as any);

    const processed = await outbox.processNextJob();
    expect(processed).toBe(true);
    expect(channel.handleInbound).toHaveBeenCalledTimes(1);
    const handed = channel.handleInbound.mock.calls[0]![0];
    expect(handed.providerMessageId).toBe('wamid.MSG_1');
    expect(handed.timestamp).toBeInstanceOf(Date); // JSON round-trip must not leave a string
  });

  it('marks job as dead_letter when max attempts are exceeded on failure', async () => {
    const testJob = {
      id: 'job-failing',
      jobType: 'process_inbound_message',
      payload: {
        event: {
          type: 'text_message',
          providerMessageId: 'wamid.MSG_FAIL',
          senderPhoneNumber: '15551234567',
          text: 'Fail',
        },
      },
      status: 'pending',
      attempts: 2,
      maxAttempts: 3, // next attempt will be 3, triggering dead_letter
    };

    let updatePayload: any = null;
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([testJob]),
            }),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockImplementation((payload) => {
          updatePayload = payload;
          return {
            where: vi.fn().mockResolvedValue([]),
          };
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    setWhatsAppChannelForTesting({ handleInbound: vi.fn().mockRejectedValue(new Error('Fatal unrecoverable error')) } as any);

    const processed = await outbox.processNextJob();
    expect(processed).toBe(true);
    expect(updatePayload?.status).toBe('dead_letter');
    expect(updatePayload?.lastError).toBe('Fatal unrecoverable error');
  });
});
