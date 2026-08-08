CREATE TYPE "public"."account_status" AS ENUM('healthy', 'payment_problem', 'incorrect_password', 'invalid_email', 'something_went_wrong', 'archived', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."audit_action" AS ENUM('create', 'update', 'delete', 'restore', 'archive', 'login', 'logout');--> statement-breakpoint
CREATE TYPE "public"."audit_entity" AS ENUM('user', 'customer', 'account', 'profile', 'backup', 'settings');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'running', 'completed', 'failed', 'verified');--> statement-breakpoint
CREATE TYPE "public"."backup_type" AS ENUM('hourly', 'daily', 'manual');--> statement-breakpoint
CREATE TYPE "public"."profile_event_type" AS ENUM('created', 'sold', 'replaced', 'extended', 'expired', 'pin_changed', 'name_changed', 'customer_changed', 'status_changed');--> statement-breakpoint
CREATE TYPE "public"."profile_status" AS ENUM('available', 'reserved', 'sold', 'expiring_soon', 'expired');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('super_admin', 'worker');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"role" "user_role" DEFAULT 'worker' NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text,
	"phone_original" text NOT NULL,
	"phone_normalized" text NOT NULL,
	"whatsapp_url" text NOT NULL,
	"notes" text,
	"first_purchase_at" timestamp with time zone,
	"last_purchase_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "customers_phone_normalized_digits" CHECK ("customers"."phone_normalized" ~ '^[0-9]{6,20}$')
);
--> statement-breakpoint
CREATE TABLE "accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"status" "account_status" DEFAULT 'healthy' NOT NULL,
	"health_score" integer DEFAULT 100 NOT NULL,
	"country" text,
	"notes" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "accounts_health_score_range" CHECK ("accounts"."health_score" between 0 and 100),
	CONSTRAINT "accounts_email_shape" CHECK ("accounts"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$')
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"profile_number" smallint NOT NULL,
	"profile_name" text,
	"pin" text,
	"status" "profile_status" DEFAULT 'available' NOT NULL,
	"customer_id" uuid,
	"worker_id" uuid,
	"sale_date" date,
	"expiration_date" date,
	"duration_days" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_number_range" CHECK ("profiles"."profile_number" between 1 and 5),
	CONSTRAINT "profiles_duration_positive" CHECK ("profiles"."duration_days" is null or "profiles"."duration_days" > 0),
	CONSTRAINT "profiles_expiry_after_sale" CHECK ("profiles"."sale_date" is null or "profiles"."expiration_date" is null or "profiles"."expiration_date" >= "profiles"."sale_date"),
	CONSTRAINT "profiles_held_requires_customer" CHECK (("profiles"."status" in ('sold', 'reserved', 'expiring_soon') and "profiles"."customer_id" is not null)
          or ("profiles"."status" = 'available' and "profiles"."customer_id" is null)
          or "profiles"."status" = 'expired')
);
--> statement-breakpoint
CREATE TABLE "profile_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"profile_id" uuid NOT NULL,
	"event_type" "profile_event_type" NOT NULL,
	"user_id" uuid,
	"customer_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" "audit_entity" NOT NULL,
	"entity_id" uuid NOT NULL,
	"action" "audit_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"user_id" uuid,
	"actor_email" text,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "backup_type" NOT NULL,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"filename" text,
	"size_bytes" bigint,
	"checksum" text,
	"is_restore_point" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	CONSTRAINT "backups_completed_has_artifact" CHECK ("backups"."status" not in ('completed', 'verified')
          or ("backups"."filename" is not null and "backups"."checksum" is not null and "backups"."completed_at" is not null)),
	CONSTRAINT "backups_failed_has_reason" CHECK ("backups"."status" <> 'failed' or "backups"."error_message" is not null),
	CONSTRAINT "backups_verified_has_timestamp" CHECK ("backups"."status" <> 'verified' or "backups"."verified_at" is not null)
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_singleton_true" CHECK ("settings"."singleton" = true)
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_worker_id_users_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_events" ADD CONSTRAINT "profile_events_account_id_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_events" ADD CONSTRAINT "profile_events_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_events" ADD CONSTRAINT "profile_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_events" ADD CONSTRAINT "profile_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique_live" ON "users" USING btree ("email") WHERE "users"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");--> statement-breakpoint
CREATE INDEX "users_status_idx" ON "users" USING btree ("status");--> statement-breakpoint
CREATE INDEX "users_created_at_idx" ON "users" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_phone_normalized_unique_live" ON "customers" USING btree ("phone_normalized") WHERE "customers"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "customers_phone_original_idx" ON "customers" USING btree ("phone_original");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree ("name");--> statement-breakpoint
CREATE INDEX "customers_created_at_idx" ON "customers" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "customers_last_purchase_at_idx" ON "customers" USING btree ("last_purchase_at");--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_email_unique_live" ON "accounts" USING btree ("email") WHERE "accounts"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "accounts_status_idx" ON "accounts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "accounts_created_at_idx" ON "accounts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "accounts_created_by_idx" ON "accounts" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "accounts_country_idx" ON "accounts" USING btree ("country");--> statement-breakpoint
CREATE INDEX "accounts_stock_selection_idx" ON "accounts" USING btree ("status","health_score" DESC NULLS LAST) WHERE "accounts"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_account_number_unique" ON "profiles" USING btree ("account_id","profile_number");--> statement-breakpoint
CREATE INDEX "profiles_account_id_idx" ON "profiles" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "profiles_status_idx" ON "profiles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "profiles_customer_id_idx" ON "profiles" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "profiles_worker_id_idx" ON "profiles" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "profiles_pin_idx" ON "profiles" USING btree ("pin");--> statement-breakpoint
CREATE INDEX "profiles_sale_date_idx" ON "profiles" USING btree ("sale_date");--> statement-breakpoint
CREATE INDEX "profiles_expiration_date_idx" ON "profiles" USING btree ("expiration_date") WHERE "profiles"."expiration_date" is not null;--> statement-breakpoint
CREATE INDEX "profiles_availability_idx" ON "profiles" USING btree ("account_id","status") WHERE "profiles"."status" = 'available';--> statement-breakpoint
CREATE INDEX "profile_events_account_created_idx" ON "profile_events" USING btree ("account_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "profile_events_profile_created_idx" ON "profile_events" USING btree ("profile_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "profile_events_type_idx" ON "profile_events" USING btree ("event_type");--> statement-breakpoint
CREATE INDEX "profile_events_customer_id_idx" ON "profile_events" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "profile_events_user_id_idx" ON "profile_events" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_events_created_at_idx" ON "profile_events" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity","entity_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_user_created_idx" ON "audit_logs" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backups_type_idx" ON "backups" USING btree ("type");--> statement-breakpoint
CREATE INDEX "backups_status_idx" ON "backups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backups_created_at_idx" ON "backups" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "backups_restore_point_idx" ON "backups" USING btree ("created_at" DESC NULLS LAST) WHERE "backups"."is_restore_point" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "settings_singleton_unique" ON "settings" USING btree ("singleton");