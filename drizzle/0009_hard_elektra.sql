CREATE TABLE IF NOT EXISTS "bank_payment_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_no" varchar(40) NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"bank_code" varchar(12) NOT NULL,
	"purpose" varchar(16) DEFAULT 'SALARY' NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"format" varchar(8) NOT NULL,
	"row_count" integer NOT NULL,
	"total_amount" integer NOT NULL,
	"checksum" varchar(64) NOT NULL,
	"byte_length" integer NOT NULL,
	"policy_version_id" uuid,
	"status" varchar(16) DEFAULT 'GENERATED' NOT NULL,
	"generated_by" varchar(120) NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"returned_count" integer DEFAULT 0 NOT NULL,
	"notes" text,
	CONSTRAINT "uq_bank_batches_no" UNIQUE("batch_no"),
	CONSTRAINT "chk_bank_batches_counts" CHECK ("bank_payment_batches"."row_count" > 0 AND "bank_payment_batches"."total_amount" > 0 AND "bank_payment_batches"."byte_length" > 0 AND "bank_payment_batches"."returned_count" >= 0),
	CONSTRAINT "chk_bank_batches_status" CHECK ("bank_payment_batches"."status" IN ('GENERATED','SENT','RETURNED','VOID')),
	CONSTRAINT "chk_bank_batches_purpose" CHECK ("bank_payment_batches"."purpose" IN ('SALARY','TRANSFER'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" varchar(32) NOT NULL,
	"account_number" varchar(32) NOT NULL,
	"account_name" varchar(120) NOT NULL,
	"bank_code" varchar(12) NOT NULL,
	"bank_name" varchar(120),
	"branch" varchar(120),
	"is_primary" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_bank_accounts_person" UNIQUE("employee_code","bank_code","account_number"),
	CONSTRAINT "chk_bank_accounts_digits" CHECK ("employee_bank_accounts"."account_number" ~ '^[0-9]{6,20}$'),
	CONSTRAINT "chk_bank_accounts_bank" CHECK (length("employee_bank_accounts"."bank_code") >= 3)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "bank_payment_batches" ADD CONSTRAINT "bank_payment_batches_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_bank_accounts" ADD CONSTRAINT "employee_bank_accounts_employee_code_employees_employee_code_fk" FOREIGN KEY ("employee_code") REFERENCES "public"."employees"("employee_code") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bank_batches_pay_run" ON "bank_payment_batches" USING btree ("pay_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bank_batches_one_active" ON "bank_payment_batches" USING btree ("pay_run_id","bank_code") WHERE "bank_payment_batches"."status" <> 'VOID';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_bank_accounts_employee" ON "employee_bank_accounts" USING btree ("employee_code");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_bank_accounts_one_primary" ON "employee_bank_accounts" USING btree ("employee_code") WHERE "employee_bank_accounts"."is_primary" = true;