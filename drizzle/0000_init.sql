CREATE TYPE "public"."audit_action" AS ENUM('CREATE', 'UPDATE', 'ACTIVATE', 'ARCHIVE', 'REJECT', 'DELETE');--> statement-breakpoint
CREATE TYPE "public"."policy_status" AS ENUM('DRAFT', 'ACTIVE', 'ARCHIVED', 'REJECTED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pay_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"period_month" integer NOT NULL,
	"period_year" integer NOT NULL,
	"status" varchar(20) DEFAULT 'DRAFT' NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"policy_version_ids" jsonb,
	"gross_total" integer DEFAULT 0 NOT NULL,
	"employee_si_total" integer DEFAULT 0 NOT NULL,
	"employer_si_total" integer DEFAULT 0 NOT NULL,
	"pit_total" integer DEFAULT 0 NOT NULL,
	"net_total" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_pay_run_period" UNIQUE("period_year","period_month"),
	CONSTRAINT "chk_pay_run_period" CHECK ("pay_runs"."period_month" >= 1 AND "pay_runs"."period_month" <= 12 AND "pay_runs"."period_year" >= 2000)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind_code" varchar(64) NOT NULL,
	"version_id" uuid,
	"version" integer,
	"action" "audit_action" NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"changed_fields" jsonb,
	"actor_id" varchar(100) NOT NULL,
	"actor_ip" varchar(64),
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_kinds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(64) NOT NULL,
	"name_vi" varchar(200) NOT NULL,
	"name_en" varchar(200),
	"description" text,
	"params_schema" jsonb NOT NULL,
	"rounding_mode" varchar(20) DEFAULT 'HALF_UP_VND' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "policy_kinds_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "policy_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind_code" varchar(64) NOT NULL,
	"version" integer NOT NULL,
	"status" "policy_status" DEFAULT 'DRAFT' NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"params" jsonb NOT NULL,
	"legal_basis" text,
	"note" text,
	"created_by" varchar(100),
	"approved_by" varchar(100),
	"approved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_policy_kind_version" UNIQUE("kind_code","version"),
	CONSTRAINT "chk_policy_effective_range" CHECK ("policy_versions"."effective_to" IS NULL OR "policy_versions"."effective_to" > "policy_versions"."effective_from"),
	CONSTRAINT "chk_policy_active_requires_approval" CHECK ("policy_versions"."status" <> 'ACTIVE' OR ("policy_versions"."approved_by" IS NOT NULL AND "policy_versions"."approved_at" IS NOT NULL))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "policy_versions" ADD CONSTRAINT "policy_versions_kind_code_policy_kinds_code_fk" FOREIGN KEY ("kind_code") REFERENCES "public"."policy_kinds"("code") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_pay_runs_status" ON "pay_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_audit_kind_time" ON "policy_audit_logs" USING btree ("kind_code","at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_audit_version" ON "policy_audit_logs" USING btree ("version_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_policy_versions_resolve" ON "policy_versions" USING btree ("kind_code","status","effective_from");