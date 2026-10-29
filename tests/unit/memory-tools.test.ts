import { describe, it, expect, vi } from 'vitest';
import { createMemoryTools } from '../../src/services/memory/tools/memory-tools';
import type { MemoryService } from '../../src/services/memory/memory-service';
import type { ToolExecutionContext } from '../../src/services/agent/engine/types';

describe('Workflow Memory Tools', () => {
  const fakeMemory = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'user-123',
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

  const mockMemoryService = {
    createMemory: vi.fn().mockResolvedValue(fakeMemory),
    searchMemories: vi.fn().mockResolvedValue([fakeMemory]),
    listMemories: vi.fn().mockResolvedValue({ memories: [fakeMemory], total: 1 }),
    updateMemory: vi.fn().mockResolvedValue({ ...fakeMemory, title: 'Updated Title' }),
    deleteMemory: vi.fn().mockResolvedValue(true),
    deleteAllMemories: vi.fn().mockResolvedValue(5),
  } as unknown as MemoryService;

  const fakeCtx: ToolExecutionContext = {
    userId: 'user-123',
    taskId: 'task-456',
    executionId: 'exec-789',
    toolCallId: 'call-001',
    idempotencyKey: 'idem-key-abc',
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  };

  const tools = createMemoryTools(mockMemoryService);
  const byName = (name: string) => tools.find((t) => t.name === name)!;

  it('registers all 5 expected Memory tools', () => {
    const names = tools.map((t) => t.name);
    expect(names).toContain('memory_save');
    expect(names).toContain('memory_search');
    expect(names).toContain('memory_list');
    expect(names).toContain('memory_update');
    expect(names).toContain('memory_delete');
    expect(tools.length).toBe(5);
  });

  describe('memory_save', () => {
    const tool = byName('memory_save');

    it('has correct tool metadata', () => {
      expect(tool.permissions).toEqual(['memory:write']);
      expect(tool.sideEffect).toBe('idempotent');
      expect(tool.requiresConfirmation).toBe(false);
    });

    it('saves explicit user request as approved', async () => {
      const input = {
        type: 'preference',
        title: 'Concise Emails',
        content: 'User prefers concise email replies.',
        isExplicitUserRequest: true,
      };
      const res = await tool.execute(input, fakeCtx);

      expect(mockMemoryService.createMemory).toHaveBeenCalledWith('user-123', {
        type: 'preference',
        title: 'Concise Emails',
        content: 'User prefers concise email replies.',
        searchKeywords: undefined,
        project: undefined,
        source: 'explicit_user',
        approvalState: 'approved',
      });
      expect(res.ok).toBe(true);
      expect(res.approvalState).toBe('approved');
      expect(res.note).toContain('saved and active');
    });

    it('saves inferred memory as pending_approval', async () => {
      (mockMemoryService.createMemory as any).mockResolvedValueOnce({
        ...fakeMemory,
        source: 'inferred',
        approvalState: 'pending_approval',
      });

      const input = {
        type: 'workflow',
        title: 'Weekly Report',
        content: 'Draft report on Mondays at 9am.',
        isExplicitUserRequest: false,
      };
      const res = await tool.execute(input, fakeCtx);

      expect(mockMemoryService.createMemory).toHaveBeenCalledWith('user-123', {
        type: 'workflow',
        title: 'Weekly Report',
        content: 'Draft report on Mondays at 9am.',
        searchKeywords: undefined,
        project: undefined,
        source: 'inferred',
        approvalState: 'pending_approval',
      });
      expect(res.approvalState).toBe('pending_approval');
      expect(res.note).toContain('pending approval');
    });
  });

  describe('memory_search', () => {
    const tool = byName('memory_search');

    it('has read-only metadata', () => {
      expect(tool.permissions).toEqual(['memory:read']);
      expect(tool.sideEffect).toBe('none');
      expect(tool.requiresConfirmation).toBe(false);
    });

    it('searches with user context', async () => {
      const res = await tool.execute({ query: 'email tone', limit: 3 }, fakeCtx);
      expect(mockMemoryService.searchMemories).toHaveBeenCalledWith('user-123', {
        query: 'email tone',
        type: undefined,
        project: undefined,
        limit: 3,
      });
      expect(res.ok).toBe(true);
      expect(res.count).toBe(1);
    });
  });

  describe('memory_list', () => {
    const tool = byName('memory_list');

    it('lists memories with filters and pagination', async () => {
      const res = await tool.execute({ type: 'preference', limit: 10, offset: 0 }, fakeCtx);
      expect(mockMemoryService.listMemories).toHaveBeenCalledWith('user-123', {
        type: 'preference',
        limit: 10,
        offset: 0,
      });
      expect(res.ok).toBe(true);
      expect(res.total).toBe(1);
    });
  });

  describe('memory_update', () => {
    const tool = byName('memory_update');

    it('updates memory attributes with user context', async () => {
      const res = await tool.execute(
        { memoryId: '11111111-1111-4111-8111-111111111111', title: 'New Title' },
        fakeCtx
      );
      expect(mockMemoryService.updateMemory).toHaveBeenCalledWith(
        'user-123',
        '11111111-1111-4111-8111-111111111111',
        { title: 'New Title' }
      );
      expect(res.ok).toBe(true);
      expect(res.title).toBe('Updated Title');
    });
  });

  describe('memory_delete', () => {
    const tool = byName('memory_delete');

    it('enforces non_idempotent side effect and requiresConfirmation=true', () => {
      expect(tool.permissions).toEqual(['memory:write']);
      expect(tool.sideEffect).toBe('non_idempotent');
      expect(tool.requiresConfirmation).toBe(true);
      expect(tool.retry.maxRetries).toBe(0);
    });

    it('deletes single memory when memoryId is passed', async () => {
      const res = await tool.execute(
        { memoryId: '11111111-1111-4111-8111-111111111111' },
        fakeCtx
      );
      expect(mockMemoryService.deleteMemory).toHaveBeenCalledWith(
        'user-123',
        '11111111-1111-4111-8111-111111111111'
      );
      expect(res.ok).toBe(true);
      expect(res.deletedId).toBe('11111111-1111-4111-8111-111111111111');
    });

    it('deletes all memories when deleteAll=true', async () => {
      const res = await tool.execute({ deleteAll: true }, fakeCtx);
      expect(mockMemoryService.deleteAllMemories).toHaveBeenCalledWith('user-123');
      expect(res.ok).toBe(true);
      expect(res.deletedCount).toBe(5);
    });

    it('provides clear describeCall for confirmations', () => {
      expect(
        tool.describeCall!({ memoryId: '11111111-1111-4111-8111-111111111111' }, fakeCtx)
      ).toBe('Delete memory 11111111-1111-4111-8111-111111111111');
      expect(tool.describeCall!({ deleteAll: true }, fakeCtx)).toContain('Delete ALL');
    });
  });
});
