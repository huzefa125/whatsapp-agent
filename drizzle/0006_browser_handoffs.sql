CREATE TABLE "browser_handoffs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid,
	"run_id" uuid,
	"connection_id" uuid,
	"origin" varchar(255) NOT NULL,
	"target_url" text NOT NULL,
	"reason" varchar(16) DEFAULT 'login' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"session_hash" varchar(64),
	"idempotency_key" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"session_expires_at" timestamp with time zone,
	"redeemed_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"failure_code" varchar(64),
	"link_sent_at" timestamp with time zone,
	"result_notified_at" timestamp with time zone,
	"resumed_task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_handoffs_status_chk" CHECK ("browser_handoffs"."status" in ('pending','active','completed','expired','cancelled','failed')),
	CONSTRAINT "browser_handoffs_reason_chk" CHECK ("browser_handoffs"."reason" in ('login','mfa','captcha'))
);
--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_task_id_agent_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."agent_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_run_id_browser_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."browser_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_handoffs" ADD CONSTRAINT "browser_handoffs_connection_id_browser_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."browser_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_token_hash_idx" ON "browser_handoffs" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_session_hash_idx" ON "browser_handoffs" USING btree ("session_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "browser_handoffs_user_idempotency_idx" ON "browser_handoffs" USING btree ("user_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "browser_handoffs_user_status_idx" ON "browser_handoffs" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "browser_handoffs_status_expires_idx" ON "browser_handoffs" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "browser_handoffs_run_idx" ON "browser_handoffs" USING btree ("run_id");