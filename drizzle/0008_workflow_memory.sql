-- Workflow Memories table: stores user-approved preferences, reusable workflows, facts, and project context.
-- Enforces per-user ownership, type classification, approval states, and full-text search capabilities.
CREATE TABLE IF NOT EXISTS "workflow_memories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users" ("id") ON DELETE CASCADE,
  "type" varchar(32) NOT NULL,
  "title" varchar(255) NOT NULL,
  "content" text NOT NULL,
  "search_keywords" text,
  "source" varchar(32) NOT NULL DEFAULT 'explicit_user',
  "provenance" text,
  "status" varchar(16) NOT NULL DEFAULT 'active',
  "approval_state" varchar(32) NOT NULL DEFAULT 'approved',
  "confidence" real NOT NULL DEFAULT 1.0,
  "project" varchar(128),
  "integration" varchar(64),
  "expires_at" timestamp with time zone,
  "last_accessed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "workflow_memories_type_chk" CHECK ("type" IN ('preference', 'workflow', 'fact', 'project_context')),
  CONSTRAINT "workflow_memories_status_chk" CHECK ("status" IN ('active', 'archived', 'expired')),
  CONSTRAINT "workflow_memories_approval_chk" CHECK ("approval_state" IN ('approved', 'pending_approval', 'rejected')),
  CONSTRAINT "workflow_memories_source_chk" CHECK ("source" IN ('explicit_user', 'inferred', 'system'))
);

CREATE INDEX IF NOT EXISTS "workflow_memories_user_status_approval_idx" ON "workflow_memories" ("user_id", "status", "approval_state");
CREATE INDEX IF NOT EXISTS "workflow_memories_user_type_idx" ON "workflow_memories" ("user_id", "type");
CREATE INDEX IF NOT EXISTS "workflow_memories_user_project_idx" ON "workflow_memories" ("user_id", "project");
CREATE INDEX IF NOT EXISTS "workflow_memories_expires_idx" ON "workflow_memories" ("expires_at");
CREATE INDEX IF NOT EXISTS "workflow_memories_updated_idx" ON "workflow_memories" ("updated_at");
