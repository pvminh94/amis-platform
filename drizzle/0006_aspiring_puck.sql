CREATE TABLE IF NOT EXISTS "gl_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" varchar(12) NOT NULL,
	"name_vi" varchar(200) NOT NULL,
	"type" varchar(12) NOT NULL,
	"normal_side" varchar(6) NOT NULL,
	"parent_code" varchar(12),
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "gl_accounts_code_unique" UNIQUE("code"),
	CONSTRAINT "chk_gl_accounts_type" CHECK ("gl_accounts"."type" IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
	CONSTRAINT "chk_gl_accounts_side" CHECK ("gl_accounts"."normal_side" IN ('DEBIT','CREDIT'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gl_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_no" varchar(60) NOT NULL,
	"entry_type" varchar(40) NOT NULL,
	"posting_date" date NOT NULL,
	"period_year" integer NOT NULL,
	"period_month" integer NOT NULL,
	"memo" text,
	"source_type" varchar(40) NOT NULL,
	"source_id" uuid NOT NULL,
	"total_debit" integer NOT NULL,
	"total_credit" integer NOT NULL,
	"posted_by" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_gl_entries_no" UNIQUE("entry_no"),
	CONSTRAINT "chk_gl_entries_balanced" CHECK ("gl_entries"."total_debit" = "gl_entries"."total_credit"),
	CONSTRAINT "chk_gl_entries_positive" CHECK ("gl_entries"."total_debit" >= 0 AND "gl_entries"."total_credit" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gl_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"line_no" integer NOT NULL,
	"account_code" varchar(12) NOT NULL,
	"side" varchar(6) NOT NULL,
	"amount" integer NOT NULL,
	"memo" text,
	CONSTRAINT "uq_gl_lines_entry_line" UNIQUE("entry_id","line_no"),
	CONSTRAINT "chk_gl_lines_side" CHECK ("gl_lines"."side" IN ('DEBIT','CREDIT')),
	CONSTRAINT "chk_gl_lines_amount" CHECK ("gl_lines"."amount" > 0)
);
--> statement-breakpoint
ALTER TABLE "payslips" ADD COLUMN "si_breakdown" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gl_lines" ADD CONSTRAINT "gl_lines_entry_id_gl_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."gl_entries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gl_entries_period" ON "gl_entries" USING btree ("period_year","period_month");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gl_entries_source" ON "gl_entries" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_gl_lines_account" ON "gl_lines" USING btree ("account_code");