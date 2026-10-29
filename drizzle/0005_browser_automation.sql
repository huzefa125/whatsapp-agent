CREATE TABLE "browser_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"origin" varchar(255) NOT NULL,
	"label" varchar(80),
	"status" varchar(16) DEFAULT 'connected' NOT NULL,
	"encrypted_state" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_connections_status_chk" CHECK ("browser_connections"."status" in ('connected','expired','revoked'))
);
--> statement-breakpoint
CREATE TABLE "browser_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"connection_id" uuid,
	"status" varchar(24) DEFAULT 'queued' NOT NULL,
	"scope_host" varchar(255) NOT NULL,
	"start_url" text NOT NULL,
	"checkpoint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"step_count" integer DEFAULT 0 NOT NULL,
	"navigation_count" integer DEFAULT 0 NOT NULL,
	"recovery_count" integer DEFAULT 0 NOT NULL,
	"wait_reason" varchar(32),
	"error_code" varchar(64),
	"error_message" text,
	"idempotency_key" varchar(128),
	"deadline_at" timestamp with time zone NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_runs_status_chk" CHECK ("browser_runs"."status" in ('queued','running','waiting_for_user','completed','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "browser_connections" ADD CONSTRAINT "browser_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_runs" ADD CONSTRAINT "browser_runs_connection_id_browser_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."browser_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_connections_user_origin_idx" ON "browser_connections" USING btree ("user_id","origin");--> statement-breakpoint
CREATE INDEX "browser_runs_user_status_idx" ON "browser_runs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "browser_runs_status_activity_idx" ON "browser_runs" USING btree ("status","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_runs_user_idempotency_idx" ON "browser_runs" USING btree ("user_id","idempotency_key");