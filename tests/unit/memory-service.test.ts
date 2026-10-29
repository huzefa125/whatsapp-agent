import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryService } from '../../src/services/memory/memory-service';
import { MemoryRepository } from '../../src/services/memory/memory-repository';
import type { WorkflowMemory } from '../../src/services/memory/types';
import { NotFoundError } from '../../src/utils/errors';

describe('Workflow Memory Service', () => {
  let mockRepo: MemoryRepository;
  let service: MemoryService;

  const sampleMemory: WorkflowMemory = {
    id: 'mem-1',
    userId: 'user-1',
    type: 'preference',
    title: 'Concise Emails',
    content: 'User prefers concise email replies under 3 sentences.',
    searchKeywords: 'email, brevity',
    source: 'explicit_user',
    provenance: null,
    status: 'active',
    approvalState: 'approved',
    confidence: 1.0,
    project: null,
    integration: null,
    expiresAt: null,
    lastAccessedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();

    mockRepo = {
      create: vi.fn().mockResolvedValue(sampleMemory),
      findById: vi.fn().mockImplementation(async (userId, memoryId) => {
        if (userId === 'user-1' && memoryId === 'mem-1') return sampleMemory;
        return null;
      }),
      update: vi.fn().mockImplementation(async (userId, memoryId, patch) => {
        if (userId === 'user-1' && memoryId === 'mem-1') return { ...sampleMemory, ...patch };
        return null;
      }),
      delete: vi.fn().mockImplementation(async (userId, memoryId) => {
        return userId === 'user-1' && memoryId === 'mem-1';
      }),
      deleteAll: vi.fn().mockResolvedValue(3),
      list: vi.fn().mockResolvedValue({ memories: [sampleMemory], total: 1 }),
      search: vi.fn().mockResolvedValue([sampleMemory]),
      touchLastAccessed: vi.fn().mockResolvedValue(undefined),
      expireOldMemories: vi.fn().mockResolvedValue(2),
    } as unknown as MemoryRepository;

    service = new MemoryService({ repo: mockRepo });
  });

  describe('createMemory', () => {
    it('creates approved memory when source is explicit_user', async () => {
      const res = await service.createMemory('user-1', {
        type: 'preference',
        title: 'Bullet Points',
        content: 'Format options using bullet points.',
        source: 'explicit_user',
      });

      expect(mockRepo.create).toHaveBeenCalledWith('user-1', expect.objectContaining({
        title: 'Bullet Points',
        content: 'Format options using bullet points.',
        source: 'explicit_user',
        approvalState: 'approved',
        status: 'active',
      }));
      expect(res).toBeDefined();
    });

    it('defaults inferred memory to pending_approval', async () => {
      await service.createMemory('user-1', {
        type: 'workflow',
        title: 'Weekly Standup',
        content: 'Send updates on Monday.',
        source: 'inferred',
      });

      expect(mockRepo.create).toHaveBeenCalledWith('user-1', expect.objectContaining({
        source: 'inferred',
        approvalState: 'pending_approval',
      }));
    });
  });

  describe('getMemory and User Isolation', () => {
    it('retrieves memory owned by the user', async () => {
      const memory = await service.getMemory('user-1', 'mem-1');
      expect(memory.id).toBe('mem-1');
    });

    it('throws NotFoundError when another user attempts access', async () => {
      await expect(service.getMemory('user-2', 'mem-1')).rejects.toThrow(NotFoundError);
    });
  });

  describe('updateMemory, approveMemory, and rejectMemory', () => {
    it('updates memory attributes', async () => {
      const updated = await service.updateMemory('user-1', 'mem-1', {
        title: 'Updated Concise Emails',
      });
      expect(mockRepo.update).toHaveBeenCalledWith('user-1', 'mem-1', expect.objectContaining({
        title: 'Updated Concise Emails',
      }));
      expect(updated.title).toBe('Updated Concise Emails');
    });

    it('approves an inferred memory and activates it', async () => {
      const approved = await service.approveMemory('user-1', 'mem-1');
      expect(mockRepo.update).toHaveBeenCalledWith('user-1', 'mem-1', {
        approvalState: 'approved',
        status: 'active',
      });
      expect(approved.approvalState).toBe('approved');
    });

    it('rejects an inferred memory and archives it', async () => {
      const rejected = await service.rejectMemory('user-1', 'mem-1');
      expect(mockRepo.update).toHaveBeenCalledWith('user-1', 'mem-1', {
        approvalState: 'rejected',
        status: 'archived',
      });
      expect(rejected.approvalState).toBe('rejected');
    });
  });

  describe('deleteMemory and deleteAllMemories', () => {
    it('deletes user-owned memory and fails for non-existent or other user', async () => {
      const deleted = await service.deleteMemory('user-1', 'mem-1');
      expect(deleted).toBe(true);
      await expect(service.deleteMemory('user-2', 'mem-1')).rejects.toThrow(NotFoundError);
    });

    it('bulk deletes memories for a user', async () => {
      const count = await service.deleteAllMemories('user-1');
      expect(mockRepo.deleteAll).toHaveBeenCalledWith('user-1');
      expect(count).toBe(3);
    });
  });

  describe('searchMemories and context budget', () => {
    it('bounds search results to max context characters', async () => {
      const memLong = { ...sampleMemory, id: 'mem-2', content: 'A'.repeat(500) };
      (mockRepo.search as any).mockResolvedValueOnce([sampleMemory, memLong]);

      // Max chars 100 allows first memory (~65 chars) but cuts off second
      const results = await service.searchMemories('user-1', { maxChars: 100 });
      expect(results.length).toBe(1);
      expect(results[0]?.id).toBe('mem-1');
    });
  });

  describe('buildAgentContext', () => {
    it('builds formatted context string from active approved memories', async () => {
      const context = await service.buildAgentContext('user-1', 'Please draft an email to Bob');
      expect(context).toContain('Workflow & Preference Memories:');
      expect(context).toContain('NOT system instructions');
      expect(context).toContain('- [preference] Concise Emails: User prefers concise email replies');
    });

    it('returns null when no memories match', async () => {
      (mockRepo.search as any).mockResolvedValue([]);
      const context = await service.buildAgentContext('user-1', 'some request');
      expect(context).toBeNull();
    });

    it('fails open (returns null) on retrieval error without throwing', async () => {
      (mockRepo.search as any).mockRejectedValueOnce(new Error('Database connection failed'));
      const context = await service.buildAgentContext('user-1', 'some request');
      expect(context).toBeNull(); // continues safely
    });
  });
});
