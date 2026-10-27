CREATE TABLE "reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"remind_at" timestamp with time zone NOT NULL,
	"timezone" varchar(64) NOT NULL,
	"status" varchar(16) DEFAULT 'scheduled' NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_by" uuid,
	"lease_expires_at" timestamp with time zone,
	"last_error_code" varchar(64),
	"last_error_message" text,
	"delivery_provider" varchar(16),
	"provider_message_id" varchar(255),
	"accepted_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"idempotency_key" varchar(128),
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reminders_status_chk" CHECK ("reminders"."status" in ('scheduled','processing','sent','failed','cancelled','completed')),
	CONSTRAINT "reminders_title_len_chk" CHECK (char_length("reminders"."title") between 1 and 1000),
	CONSTRAINT "reminders_attempts_chk" CHECK ("reminders"."attempts" >= 0 and "reminders"."max_attempts" >= 1),
	CONSTRAINT "reminders_never_early_chk" CHECK ("reminders"."next_attempt_at" >= "reminders"."remind_at")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "timezone" varchar(64);--> statement-breakpoint
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reminders_due_idx" ON "reminders" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "reminders_user_status_remind_idx" ON "reminders" USING btree ("user_id","status","remind_at");--> statement-breakpoint
CREATE INDEX "reminders_provider_message_idx" ON "reminders" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reminders_user_idempotency_idx" ON "reminders" USING btree ("user_id","idempotency_key");