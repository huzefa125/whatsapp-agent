import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentOrchestrator } from '../../src/services/agent/orchestrator';
import { setAiProviderForTesting } from '../../src/services/ai';
import { StubAiProvider } from '../../src/services/ai/stub';
import * as dbClient from '../../src/db/client';

describe('AgentOrchestrator', () => {
  const orchestrator = new AgentOrchestrator(10);
  const stubAi = new StubAiProvider('Hello, how can I assist you today?');

  beforeEach(() => {
    vi.restoreAllMocks();
    setAiProviderForTesting(stubAi);
  });

  it('detects duplicate messages by providerMessageId and skips AI generation (idempotency)', async () => {
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              { id: 'existing-msg-uuid', providerMessageId: 'wamid.DUPLICATE_ID' },
            ]),
          }),
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    const result = await orchestrator.processTextMessage({
      type: 'text_message',
      providerMessageId: 'wamid.DUPLICATE_ID',
      senderPhoneNumber: '15551234567',
      text: 'Hello again',
      timestamp: new Date(),
      phoneNumberId: 'PN_1',
      raw: {},
    });

    expect(result.isDuplicate).toBe(true);
    expect(result.replyText).toBe('');
  });

  it('successfully creates or resolves user and conversation, invokes AI, and records turn', async () => {
    const mockUser = { id: 'user-uuid-1', phoneNumber: '15551234567', displayName: 'Alice' };
    const mockConversation = { id: 'conv-uuid-1', userId: 'user-uuid-1', status: 'active' };

    let selectCallCount = 0;
    const mockDb = {
      select: vi.fn().mockImplementation(() => {
        selectCallCount++;
        return {
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockImplementation(async () => {
                if (selectCallCount === 1) {
                  // Duplicate check: not found
                  return [];
                }
                if (selectCallCount === 2) {
                  // User lookup: found
                  return [mockUser];
                }
                return [];
              }),
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockImplementation(async () => {
                  if (selectCallCount === 3) {
                    // Active conversation lookup: found
                    return [mockConversation];
                  }
                  // History lookup: empty
                  return [];
                }),
              }),
            }),
          }),
        };
      }),
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockResolvedValue([]),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    };

    vi.spyOn(dbClient, 'getDb').mockReturnValue(mockDb as any);

    const result = await orchestrator.processTextMessage({
      type: 'text_message',
      providerMessageId: 'wamid.NEW_MSG_123',
      senderPhoneNumber: '15551234567',
      senderName: 'Alice',
      text: 'What can you do?',
      timestamp: new Date(),
      phoneNumberId: 'PN_1',
      raw: {},
    });

    expect(result.isDuplicate).toBe(false);
    expect(result.replyText).toBe('Hello, how can I assist you today?');
    expect(result.userId).toBe('user-uuid-1');
    expect(result.conversationId).toBe('conv-uuid-1');

    // User message and assistant response must both be inserted
    expect(mockDb.insert).toHaveBeenCalledTimes(2);
  });
});
