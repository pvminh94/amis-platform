CREATE TABLE IF NOT EXISTS "approval_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"action" varchar(20) NOT NULL,
	"from_status" varchar(20) NOT NULL,
	"to_status" varchar(20) NOT NULL,
	"step" integer,
	"actor_id" varchar(100),
	"actor_name" varchar(200),
	"actor_role" varchar(60),
	"comment" text,
	"ip_address" varchar(45) NOT NULL,
	"user_agent" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "approval_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_type" varchar(40) NOT NULL,
	"doc_ref" uuid NOT NULL,
	"doc_label" varchar(200) NOT NULL,
	"amount" integer,
	"context" jsonb NOT NULL,
	"chain" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"state" varchar(20) DEFAULT 'DRAFT' NOT NULL,
	"current_step" integer DEFAULT 0 NOT NULL,
	"total_steps" integer NOT NULL,
	"requested_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_approval_requests_doc" UNIQUE("doc_type","doc_ref"),
	CONSTRAINT "chk_approval_requests_state" CHECK ("approval_requests"."state" IN ('DRAFT','SUBMITTED','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED','RETURNED')),
	CONSTRAINT "chk_approval_requests_steps" CHECK ("approval_requests"."total_steps" >= 1 AND "approval_requests"."current_step" >= 0 AND "approval_requests"."current_step" <= "approval_requests"."total_steps"),
	CONSTRAINT "chk_approval_requests_amount" CHECK ("approval_requests"."amount" IS NULL OR "approval_requests"."amount" >= 0)
);
--> statement-breakpoint
-- IF EXISTS: ràng buộc này có thể đã bị extras.sql bỏ trước rồi (nó chạy
-- trước migration trên các môi trường dựng lại từ đầu). Không có IF EXISTS
-- thì cả migration nổ với 42704 undefined_object.
ALTER TABLE "policy_versions" DROP CONSTRAINT IF EXISTS "uq_policy_kind_version";--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "approval_audit" ADD CONSTRAINT "approval_audit_request_id_approval_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."approval_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_approval_audit_request" ON "approval_audit" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_approval_requests_state" ON "approval_requests" USING btree ("state");