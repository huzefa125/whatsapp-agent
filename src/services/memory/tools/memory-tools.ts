import { z } from 'zod';
import type { ToolDefinition } from '../../agent/engine/types';
import type { MemoryService } from '../memory-service';

export function createMemoryTools(memoryService: MemoryService): Array<ToolDefinition<any, any>> {
  return [
    memorySaveTool(memoryService),
    memorySearchTool(memoryService),
    memoryListTool(memoryService),
    memoryUpdateTool(memoryService),
    memoryDeleteTool(memoryService),
  ];
}

// ── memory_save ───────────────────────────────────────────────────
function memorySaveTool(memory: MemoryService): ToolDefinition<any, any> {
  return {
    name: 'memory_save',
    description:
      'Save a user preference, reusable workflow, non-sensitive fact, or project context across conversations. ' +
      'Set isExplicitUserRequest: true when the user directly instructed you to remember something. ' +
      'Set isExplicitUserRequest: false when you are proposing/inferring a memory so the user can approve it before it becomes active. ' +
      'Never store passwords, tokens, API keys, or verification codes.',
    inputSchema: z
      .object({
        type: z
          .enum(['preference', 'workflow', 'fact', 'project_context'])
          .describe('The memory category: preference, workflow, fact, or project_context'),
        title: z.string().min(1).max(255).describe('Short descriptive title for this memory'),
        content: z.string().min(1).max(5000).describe('The details of the preference or workflow'),
        searchKeywords: z
          .string()
          .max(500)
          .optional()
          .describe('Optional search keywords or tags for easier retrieval'),
        project: z.string().max(128).optional().describe('Optional project name or identifier'),
        isExplicitUserRequest: z
          .boolean()
          .default(true)
          .describe(
            'True if the user explicitly asked to remember this. False if inferred by the assistant (requires approval).'
          ),
      })
      .strict(),
    permissions: ['memory:write'],
    sideEffect: 'idempotent',
    requiresConfirmation: false,
    timeoutMs: 10000,
    retry: { maxRetries: 1, backoffMs: 500 },
    async execute(input, ctx) {
      const source = input.isExplicitUserRequest ? 'explicit_user' : 'inferred';
      const approvalState = input.isExplicitUserRequest ? 'approved' : 'pending_approval';

      const created = await memory.createMemory(ctx.userId, {
        type: input.type,
        title: input.title,
        content: input.content,
        searchKeywords: input.searchKeywords,
        project: input.project,
        source,
        approvalState,
      });

      return {
        ok: true,
        memoryId: created.id,
        title: created.title,
        type: created.type,
        approvalState: created.approvalState,
        note:
          created.approvalState === 'pending_approval'
            ? 'Memory recorded as pending approval. Ask the user if they would like to save it for future use.'
            : 'Memory saved and active.',
      };
    },
    formatResult(res) {
      return res;
    },
    describeCall(input) {
      return `Remember ${input.type}: "${input.title}"`;
    },
  };
}

// ── memory_search ─────────────────────────────────────────────────
function memorySearchTool(memory: MemoryService): ToolDefinition<any, any> {
  return {
    name: 'memory_search',
    description:
      'Search the user\'s active, approved memories by keyword or phrase. Returns matching preferences and workflows.',
    inputSchema: z
      .object({
        query: z.string().min(1).max(500).describe('Search term or phrase'),
        type: z
          .enum(['preference', 'workflow', 'fact', 'project_context'])
          .optional()
          .describe('Optional filter by memory category'),
        project: z.string().max(128).optional().describe('Optional project filter'),
        limit: z.number().int().min(1).max(20).optional().default(5).describe('Max results (default 5)'),
      })
      .strict(),
    permissions: ['memory:read'],
    sideEffect: 'none',
    requiresConfirmation: false,
    timeoutMs: 10000,
    retry: { maxRetries: 1, backoffMs: 500 },
    async execute(input, ctx) {
      const results = await memory.searchMemories(ctx.userId, {
        query: input.query,
        type: input.type,
        project: input.project,
        limit: input.limit,
      });

      return {
        ok: true,
        count: results.length,
        memories: results.map((m) => ({
          id: m.id,
          type: m.type,
          title: m.title,
          content: m.content,
          project: m.project,
          updatedAt: m.updatedAt,
        })),
      };
    },
    formatResult(res) {
      return res;
    },
  };
}

// ── memory_list ───────────────────────────────────────────────────
function memoryListTool(memory: MemoryService): ToolDefinition<any, any> {
  return {
    name: 'memory_list',
    description:
      'List saved memories with pagination and optional filtering by type, status, or approval state.',
    inputSchema: z
      .object({
        type: z
          .enum(['preference', 'workflow', 'fact', 'project_context'])
          .optional()
          .describe('Filter by memory category'),
        status: z
          .enum(['active', 'archived', 'expired'])
          .optional()
          .describe('Filter by status (default lists all)'),
        approvalState: z
          .enum(['approved', 'pending_approval', 'rejected'])
          .optional()
          .describe('Filter by approval state'),
        project: z.string().max(128).optional().describe('Filter by project name'),
        limit: z.number().int().min(1).max(50).optional().default(20).describe('Max records to return'),
        offset: z.number().int().min(0).optional().default(0).describe('Pagination offset'),
      })
      .strict(),
    permissions: ['memory:read'],
    sideEffect: 'none',
    requiresConfirmation: false,
    timeoutMs: 10000,
    retry: { maxRetries: 1, backoffMs: 500 },
    async execute(input, ctx) {
      const res = await memory.listMemories(ctx.userId, input);
      return {
        ok: true,
        total: res.total,
        count: res.memories.length,
        memories: res.memories.map((m) => ({
          id: m.id,
          type: m.type,
          title: m.title,
          content: m.content,
          status: m.status,
          approvalState: m.approvalState,
          project: m.project,
          updatedAt: m.updatedAt,
        })),
      };
    },
    formatResult(res) {
      return res;
    },
  };
}

// ── memory_update ─────────────────────────────────────────────────
function memoryUpdateTool(memory: MemoryService): ToolDefinition<any, any> {
  return {
    name: 'memory_update',
    description:
      'Update an existing memory: change its title, content, category, keywords, or status (e.g., to archive or approve it).',
    inputSchema: z
      .object({
        memoryId: z.string().uuid().describe('The UUID of the memory to update'),
        title: z.string().min(1).max(255).optional().describe('Updated title'),
        content: z.string().min(1).max(5000).optional().describe('Updated content'),
        searchKeywords: z.string().max(500).optional().describe('Updated keywords'),
        project: z.string().max(128).optional().describe('Updated project'),
        status: z.enum(['active', 'archived', 'expired']).optional().describe('Updated status'),
        approvalState: z
          .enum(['approved', 'pending_approval', 'rejected'])
          .optional()
          .describe('Updated approval state'),
      })
      .strict(),
    permissions: ['memory:write'],
    sideEffect: 'idempotent',
    requiresConfirmation: false,
    timeoutMs: 10000,
    retry: { maxRetries: 1, backoffMs: 500 },
    async execute(input, ctx) {
      const { memoryId, ...patch } = input;
      const updated = await memory.updateMemory(ctx.userId, memoryId, patch);
      return {
        ok: true,
        memoryId: updated.id,
        title: updated.title,
        status: updated.status,
        approvalState: updated.approvalState,
        note: 'Memory updated successfully.',
      };
    },
    formatResult(res) {
      return res;
    },
    describeCall(input) {
      return `Update memory ${input.memoryId}`;
    },
  };
}

// ── memory_delete ─────────────────────────────────────────────────
function memoryDeleteTool(memory: MemoryService): ToolDefinition<any, any> {
  return {
    name: 'memory_delete',
    description:
      'Delete one specific memory by ID, or delete ALL memories for the user if deleteAll: true. ' +
      'Requires explicit user confirmation before executing.',
    inputSchema: z
      .object({
        memoryId: z.string().uuid().optional().describe('The UUID of the memory to delete'),
        deleteAll: z
          .boolean()
          .optional()
          .default(false)
          .describe('Set to true to delete all memories for this user'),
      })
      .strict()
      .refine((v) => v.memoryId || v.deleteAll, {
        message: 'Must provide either memoryId or deleteAll: true',
      }),
    permissions: ['memory:write'],
    sideEffect: 'non_idempotent',
    requiresConfirmation: true,
    timeoutMs: 15000,
    retry: { maxRetries: 0, backoffMs: 0 },
    async execute(input, ctx) {
      if (input.deleteAll) {
        const count = await memory.deleteAllMemories(ctx.userId);
        return {
          ok: true,
          deletedCount: count,
          message: `Deleted all ${count} memories.`,
        };
      }

      await memory.deleteMemory(ctx.userId, input.memoryId!);
      return {
        ok: true,
        deletedId: input.memoryId,
        message: 'Memory deleted successfully.',
      };
    },
    formatResult(res) {
      return res;
    },
    describeCall(input) {
      if (input.deleteAll) {
        return 'Delete ALL of your stored memories and preferences';
      }
      return `Delete memory ${input.memoryId}`;
    },
  };
}
