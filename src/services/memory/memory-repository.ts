import { eq, and, or, ilike, sql, desc, isNull, gt, lt } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { workflowMemories, type WorkflowMemory } from '../../db/schema';
import type { CreateMemoryInput, UpdateMemoryInput, SearchMemoriesOptions, ListMemoriesOptions } from './types';

export class MemoryRepository {
  async create(userId: string, input: CreateMemoryInput): Promise<WorkflowMemory> {
    const db = getDb();
    const [created] = await db
      .insert(workflowMemories)
      .values({
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
      })
      .returning();
    if (!created) {
      throw new Error('Failed to create memory record');
    }
    return created;
  }

  async findById(userId: string, memoryId: string): Promise<WorkflowMemory | null> {
    const db = getDb();
    const [memory] = await db
      .select()
      .from(workflowMemories)
      .where(and(eq(workflowMemories.id, memoryId), eq(workflowMemories.userId, userId)))
      .limit(1);
    return memory ?? null;
  }

  async update(
    userId: string,
    memoryId: string,
    patch: UpdateMemoryInput
  ): Promise<WorkflowMemory | null> {
    const db = getDb();
    const [updated] = await db
      .update(workflowMemories)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.content !== undefined ? { content: patch.content } : {}),
        ...(patch.searchKeywords !== undefined ? { searchKeywords: patch.searchKeywords } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.approvalState !== undefined ? { approvalState: patch.approvalState } : {}),
        ...(patch.confidence !== undefined ? { confidence: patch.confidence } : {}),
        ...(patch.project !== undefined ? { project: patch.project } : {}),
        ...(patch.integration !== undefined ? { integration: patch.integration } : {}),
        ...(patch.expiresAt !== undefined ? { expiresAt: patch.expiresAt } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(workflowMemories.id, memoryId), eq(workflowMemories.userId, userId)))
      .returning();
    return updated ?? null;
  }

  async delete(userId: string, memoryId: string): Promise<boolean> {
    const db = getDb();
    const result = await db
      .delete(workflowMemories)
      .where(and(eq(workflowMemories.id, memoryId), eq(workflowMemories.userId, userId)))
      .returning({ id: workflowMemories.id });
    return result.length > 0;
  }

  async deleteAll(userId: string): Promise<number> {
    const db = getDb();
    const result = await db
      .delete(workflowMemories)
      .where(eq(workflowMemories.userId, userId))
      .returning({ id: workflowMemories.id });
    return result.length;
  }

  async list(
    userId: string,
    options: ListMemoriesOptions = {}
  ): Promise<{ memories: WorkflowMemory[]; total: number }> {
    const db = getDb();
    const conditions = [eq(workflowMemories.userId, userId)];

    if (options.type) {
      conditions.push(eq(workflowMemories.type, options.type));
    }
    if (options.status) {
      conditions.push(eq(workflowMemories.status, options.status));
    }
    if (options.approvalState) {
      conditions.push(eq(workflowMemories.approvalState, options.approvalState));
    }
    if (options.project) {
      conditions.push(eq(workflowMemories.project, options.project));
    }

    const whereClause = and(...conditions);
    const limit = options.limit ?? 20;
    const offset = options.offset ?? 0;

    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(workflowMemories)
      .where(whereClause);

    const memories = await db
      .select()
      .from(workflowMemories)
      .where(whereClause)
      .orderBy(desc(workflowMemories.updatedAt))
      .limit(limit)
      .offset(offset);

    return {
      memories,
      total: countResult?.count ?? 0,
    };
  }

  async search(
    userId: string,
    options: SearchMemoriesOptions = {}
  ): Promise<WorkflowMemory[]> {
    const db = getDb();
    const now = new Date();

    const conditions = [
      eq(workflowMemories.userId, userId),
      eq(workflowMemories.status, options.status ?? 'active'),
      eq(workflowMemories.approvalState, options.approvalState ?? 'approved'),
      // Exclude expired memories
      or(isNull(workflowMemories.expiresAt), gt(workflowMemories.expiresAt, now)),
    ];

    if (options.type) {
      conditions.push(eq(workflowMemories.type, options.type));
    }
    if (options.project) {
      conditions.push(eq(workflowMemories.project, options.project));
    }
    if (options.integration) {
      conditions.push(eq(workflowMemories.integration, options.integration));
    }

    // Text search if query provided
    const query = options.query?.trim();
    if (query) {
      const term = `%${query}%`;
      conditions.push(
        or(
          ilike(workflowMemories.title, term),
          ilike(workflowMemories.content, term),
          ilike(workflowMemories.searchKeywords, term),
          ilike(workflowMemories.project, term)
        )!
      );
    }

    const limit = options.limit ?? 5;

    const memories = await db
      .select()
      .from(workflowMemories)
      .where(and(...conditions))
      .orderBy(
        // Recency + confidence priority
        desc(workflowMemories.confidence),
        desc(workflowMemories.updatedAt)
      )
      .limit(limit);

    return memories;
  }

  async touchLastAccessed(userId: string, memoryIds: string[]): Promise<void> {
    if (memoryIds.length === 0) return;
    const db = getDb();
    const now = new Date();
    for (const id of memoryIds) {
      await db
        .update(workflowMemories)
        .set({ lastAccessedAt: now })
        .where(and(eq(workflowMemories.id, id), eq(workflowMemories.userId, userId)));
    }
  }

  async expireOldMemories(now = new Date()): Promise<number> {
    const db = getDb();
    const expired = await db
      .update(workflowMemories)
      .set({ status: 'expired', updatedAt: now })
      .where(and(eq(workflowMemories.status, 'active'), lt(workflowMemories.expiresAt, now)))
      .returning({ id: workflowMemories.id });
    return expired.length;
  }
}
