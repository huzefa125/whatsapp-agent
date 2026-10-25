import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OutboxService } from '../../src/services/queue/outbox';
import * as dbClient from '../../src/db/client';
import { setAgentOrchestratorForTesting } from '../../src/services/agent/orchestrator';
import { setWhatsAppClientForTesting } from '../../src/services/whatsapp/client';

describe('OutboxService', () => {
  const outbox = new OutboxService();

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('enqueues a new message successfully', async () => {
    const mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: 'event-uuid-1' }]),
          }),
          // for outboxJobs insert
          then: (resolve: any) => resolve([]),
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    const result = await outbox.enqueueInboundMessage({
      type: 'text_message',
      providerMessageId: 'wamid.MSG_UNIQUE_1',
      senderPhoneNumber: '15551234567',
      text: 'Hello',
      timestamp: new Date(),
      phoneNumberId: 'PN_1',
      raw: {},
    });

    expect(result).toBe(true);
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });

  it('detects duplicate webhook events and skips job queue insertion', async () => {
    const mockDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]), // Conflict -> no rows returned
          }),
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    const result = await outbox.enqueueInboundMessage({
      type: 'text_message',
      providerMessageId: 'wamid.DUPLICATE_MSG',
      senderPhoneNumber: '15551234567',
      text: 'Hello',
      timestamp: new Date(),
      phoneNumberId: 'PN_1',
      raw: {},
    });

    expect(result).toBe(false);
    expect(mockDb.insert).toHaveBeenCalledTimes(1); // Did not insert into outboxJobs
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

    const mockOrchestrator = {
      processTextMessage: vi.fn().mockResolvedValue({
        replyText: 'Hello there!',
        isDuplicate: false,
      }),
    };
    setAgentOrchestratorForTesting(mockOrchestrator as any);

    const mockWhatsApp = {
      sendTextMessage: vi.fn().mockResolvedValue({
        providerMessageId: 'wamid.OUT_1',
      }),
    };
    setWhatsAppClientForTesting(mockWhatsApp as any);

    const processed = await outbox.processNextJob();
    expect(processed).toBe(true);
    expect(mockOrchestrator.processTextMessage).toHaveBeenCalled();
    expect(mockWhatsApp.sendTextMessage).toHaveBeenCalledWith({
      to: '15551234567',
      text: 'Hello there!',
    });
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

    const mockOrchestrator = {
      processTextMessage: vi.fn().mockRejectedValue(new Error('Fatal unrecoverable error')),
    };
    setAgentOrchestratorForTesting(mockOrchestrator as any);

    const processed = await outbox.processNextJob();
    expect(processed).toBe(true);
    expect(updatePayload?.status).toBe('dead_letter');
    expect(updatePayload?.lastError).toBe('Fatal unrecoverable error');
  });
});
