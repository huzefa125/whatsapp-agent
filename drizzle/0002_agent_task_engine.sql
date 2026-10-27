CREATE TABLE "agent_task_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"error_code" varchar(64),
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "agent_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"conversation_id" uuid,
	"task_type" varchar(64) NOT NULL,
	"input" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"idempotency_key" varchar(128),
	"transcript" jsonb,
	"result" jsonb,
	"error_code" varchar(64),
	"error_message" text,
	"locked_by" uuid,
	"lease_expires_at" timestamp with time zone,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"confirmation_expires_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"call_id" varchar(64) NOT NULL,
	"tool_name" varchar(128) NOT NULL,
	"args" jsonb NOT NULL,
	"status" varchar(32) NOT NULL,
	"result" text,
	"error_code" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_task_attempts" ADD CONSTRAINT "agent_task_attempts_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_tool_calls" ADD CONSTRAINT "agent_tool_calls_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_task_attempts_task_attempt_idx" ON "agent_task_attempts" USING btree ("task_id","attempt_number");--> statement-breakpoint
CREATE INDEX "agent_tasks_user_created_idx" ON "agent_tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_tasks_status_run_after_idx" ON "agent_tasks" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tasks_user_idempotency_idx" ON "agent_tasks" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_tool_calls_task_call_idx" ON "agent_tool_calls" USING btree ("task_id","call_id");