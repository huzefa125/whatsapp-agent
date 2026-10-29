import type { WorkflowMemory } from '../../db/schema';

export type MemoryType = 'preference' | 'workflow' | 'fact' | 'project_context';
export type MemorySource = 'explicit_user' | 'inferred' | 'system';
export type MemoryStatus = 'active' | 'archived' | 'expired';
export type ApprovalState = 'approved' | 'pending_approval' | 'rejected';

export interface CreateMemoryInput {
  type: MemoryType;
  title: string;
  content: string;
  searchKeywords?: string | null;
  source?: MemorySource;
  provenance?: string | null;
  status?: MemoryStatus;
  approvalState?: ApprovalState;
  confidence?: number;
  project?: string | null;
  integration?: string | null;
  expiresAt?: Date | null;
}

export interface UpdateMemoryInput {
  title?: string;
  content?: string;
  searchKeywords?: string | null;
  status?: MemoryStatus;
  approvalState?: ApprovalState;
  confidence?: number;
  project?: string | null;
  integration?: string | null;
  expiresAt?: Date | null;
}

export interface SearchMemoriesOptions {
  query?: string;
  type?: MemoryType;
  project?: string;
  integration?: string;
  status?: MemoryStatus;
  approvalState?: ApprovalState;
  limit?: number;
  maxChars?: number;
}

export interface ListMemoriesOptions {
  type?: MemoryType;
  status?: MemoryStatus;
  approvalState?: ApprovalState;
  project?: string;
  limit?: number;
  offset?: number;
}

export type { WorkflowMemory };
