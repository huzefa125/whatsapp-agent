ALTER TABLE "agent_tasks" ADD COLUMN "channel" varchar(16) DEFAULT 'api' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "reply_key" varchar(96);--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "reply_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "reply_next_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "reply_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD COLUMN "reply_error" text;--> statement-breakpoint
CREATE INDEX "agent_tasks_channel_status_idx" ON "agent_tasks" USING btree ("channel","status");