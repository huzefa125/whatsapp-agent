import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createDefaultToolRegistry } from '../../src/services/agent/engine/task-service';
import { setMemoryServiceForTesting, getMemoryService, MemoryService } from '../../src/services/memory';
import type { ToolExecutionContext } from '../../src/services/agent/engine/types';
import type { WorkflowMemory } from '../../src/services/memory/types';

describe('Workflow Memory Integration', () => {
  let memoryService: MemoryService;
  let inMemoryStore: Map<string, WorkflowMemory>;

  beforeEach(() => {
    vi.restoreAllMocks();
    inMemoryStore = new Map();

    const mockRepo = {
      create: vi.fn().mockImplementation(async (userId, input) => {
        const id = `mem-${inMemoryStore.size + 1}`;
        const record: WorkflowMemory = {
          id,
          userId,
          type: input.type,
          title: input.title,
          content: input.content,
          searchKeywords: input.searchKeywords ?? null,
          source: input.source ?? 'explicit_user',
          provenance: input.provenance ?? null,
          status: input.status ?? 'active',
          approvalState: input.approvalState ?? 'approved',
          confidence: input.confidence ?? 1.0,
          project: input.project ?? null,
          integration: input.integration ?? null,
          expiresAt: input.expiresAt ?? null,
          lastAccessedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        inMemoryStore.set(id, record);
        return record;
      }),
      findById: vi.fn().mockImplementation(async (userId, memoryId) => {
        const mem = inMemoryStore.get(memoryId);
        if (mem && mem.userId === userId) return mem;
        return null;
      }),
      update: vi.fn().mockImplementation(async (userId, memoryId, patch) => {
        const mem = inMemoryStore.get(memoryId);
        if (mem && mem.userId === userId) {
          const updated = { ...mem, ...patch, updatedAt: new Date() };
          inMemoryStore.set(memoryId, updated);
          return updated;
        }
        return null;
      }),
      delete: vi.fn().mockImplementation(async (userId, memoryId) => {
        const mem = inMemoryStore.get(memoryId);
        if (mem && mem.userId === userId) {
          inMemoryStore.delete(memoryId);
          return true;
        }
        return false;
      }),
      deleteAll: vi.fn().mockImplementation(async (userId) => {
        let count = 0;
        for (const [id, mem] of inMemoryStore.entries()) {
          if (mem.userId === userId) {
            inMemoryStore.delete(id);
            count++;
          }
        }
        return count;
      }),
      search: vi.fn().mockImplementation(async (userId, options) => {
        const results: WorkflowMemory[] = [];
        for (const mem of inMemoryStore.values()) {
          if (mem.userId !== userId) continue;
          if (options.status && mem.status !== options.status) continue;
          if (options.approvalState && mem.approvalState !== options.approvalState) continue;
          if (options.query) {
            const q = options.query.toLowerCase();
            const text = `${mem.title} ${mem.content} ${mem.searchKeywords || ''}`.toLowerCase();
            if (!text.includes(q)) continue;
          }
          results.push(mem);
        }
        return results.slice(0, options.limit ?? 5);
      }),
      list: vi.fn().mockImplementation(async (userId, options) => {
        const memories = Array.from(inMemoryStore.values()).filter((m) => m.userId === userId);
        return { memories, total: memories.length };
      }),
      touchLastAccessed: vi.fn().mockResolvedValue(undefined),
      expireOldMemories: vi.fn().mockResolvedValue(0),
    };

    memoryService = new MemoryService({ repo: mockRepo as any });
    setMemoryServiceForTesting(memoryService);
  });

  const makeCtx = (userId: string): ToolExecutionContext => ({
    userId,
    taskId: 'task-1',
    executionId: 'exec-1',
    toolCallId: 'call-1',
    idempotencyKey: 'idem-1',
    signal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  });

  it('registers all memory tools into the default engine tool registry', () => {
    const registry = createDefaultToolRegistry(undefined, memoryService);
    expect(registry.get('memory_save')).toBeDefined();
    expect(registry.get('memory_search')).toBeDefined();
    expect(registry.get('memory_list')).toBeDefined();
    expect(registry.get('memory_update')).toBeDefined();
    expect(registry.get('memory_delete')).toBeDefined();
  });

  it('end-to-end memory lifecycle: save, inject into context, search, and delete with isolation', async () => {
    const userA = 'user-alice';
    const userB = 'user-bob';

    const registry = createDefaultToolRegistry(undefined, memoryService);
    const saveTool = registry.get('memory_save')!;
    const searchTool = registry.get('memory_search')!;
    const deleteTool = registry.get('memory_delete')!;

    // 1. User Alice explicitly saves a preference
    const saveRes = (await saveTool.execute(
      {
        type: 'preference',
        title: 'Concise Emails',
        content: 'Keep all email responses under 2 sentences.',
        isExplicitUserRequest: true,
      },
      makeCtx(userA)
    )) as any;

    expect(saveRes.ok).toBe(true);
    expect(saveRes.approvalState).toBe('approved');
    const aliceMemoryId = saveRes.memoryId;

    // 2. Alice's preference is injected into agent context
    const aliceContext = await memoryService.buildAgentContext(userA, 'Please reply to John');
    expect(aliceContext).toContain('Workflow & Preference Memories:');
    expect(aliceContext).toContain('Concise Emails');

    // 3. User Bob's context does NOT see Alice's memory (Strict Isolation)
    const bobContext = await memoryService.buildAgentContext(userB, 'Please reply to John');
    expect(bobContext).toBeNull();

    // 4. Bob cannot search or see Alice's memory
    const bobSearch = (await searchTool.execute({ query: 'Concise' }, makeCtx(userB))) as any;
    expect(bobSearch.count).toBe(0);

    // 5. Bob cannot delete Alice's memory
    await expect(
      deleteTool.execute({ memoryId: aliceMemoryId }, makeCtx(userB))
    ).rejects.toThrow();

    // 6. Alice deletes her memory
    const deleteRes = (await deleteTool.execute({ memoryId: aliceMemoryId }, makeCtx(userA))) as any;
    expect(deleteRes.ok).toBe(true);

    // 7. Context immediately excludes the deleted memory
    const aliceContextAfter = await memoryService.buildAgentContext(userA, 'Please reply to John');
    expect(aliceContextAfter).toBeNull();
  });

  it('inferred workflow proposals require user approval before context injection', async () => {
    const userA = 'user-alice';
    const registry = createDefaultToolRegistry(undefined, memoryService);
    const saveTool = registry.get('memory_save')!;
    const updateTool = registry.get('memory_update')!;

    // Inferred recommendation
    const saveRes = (await saveTool.execute(
      {
        type: 'workflow',
        title: 'Weekly Report Flow',
        content: 'Compile CRM stats every Friday.',
        isExplicitUserRequest: false,
      },
      makeCtx(userA)
    )) as any;

    expect(saveRes.approvalState).toBe('pending_approval');

    // Inferred memory must NOT be injected into active context
    let context = await memoryService.buildAgentContext(userA, 'Friday tasks');
    expect(context).toBeNull();

    // User approves it
    await updateTool.execute(
      { memoryId: saveRes.memoryId, approvalState: 'approved' },
      makeCtx(userA)
    );

    // Now it is active and injected
    context = await memoryService.buildAgentContext(userA, 'Friday tasks');
    expect(context).toContain('Weekly Report Flow');
  });
});
