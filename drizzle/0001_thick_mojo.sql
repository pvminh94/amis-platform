CREATE TABLE IF NOT EXISTS "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" varchar(32) NOT NULL,
	"full_name" varchar(120) NOT NULL,
	"tax_code" varchar(20),
	"department" varchar(120) NOT NULL,
	"wage_region" varchar(2) NOT NULL,
	"trained_worker" boolean DEFAULT false NOT NULL,
	"dependents" integer DEFAULT 0 NOT NULL,
	"base_salary" integer NOT NULL,
	"hourly_rate" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_employees_code" UNIQUE("employee_code"),
	CONSTRAINT "chk_employees_region" CHECK ("employees"."wage_region" IN ('I', 'II', 'III', 'IV')),
	CONSTRAINT "chk_employees_numbers" CHECK ("employees"."base_salary" >= 0 AND "employees"."hourly_rate" >= 0 AND "employees"."dependents" >= 0 AND "employees"."dependents" <= 20)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payslips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pay_run_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"employee_code" varchar(32) NOT NULL,
	"full_name" varchar(120) NOT NULL,
	"variables" jsonb NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"components" jsonb NOT NULL,
	"earnings_total" integer NOT NULL,
	"deductions_total" integer NOT NULL,
	"taxable_income" integer NOT NULL,
	"insurance_base" integer NOT NULL,
	"si_base" integer NOT NULL,
	"ui_base" integer NOT NULL,
	"si_employee" integer NOT NULL,
	"si_employer" integer NOT NULL,
	"pit" integer NOT NULL,
	"net_pay" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_payslips_run_employee" UNIQUE("pay_run_id","employee_id"),
	CONSTRAINT "chk_payslips_amounts" CHECK ("payslips"."earnings_total" >= 0 AND "payslips"."deductions_total" <= 0 AND "payslips"."pit" >= 0
          AND "payslips"."si_employee" >= 0 AND "payslips"."si_employer" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payslips" ADD CONSTRAINT "payslips_pay_run_id_pay_runs_id_fk" FOREIGN KEY ("pay_run_id") REFERENCES "public"."pay_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payslips" ADD CONSTRAINT "payslips_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employees_department" ON "employees" USING btree ("department");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslips_run" ON "payslips" USING btree ("pay_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payslips_employee" ON "payslips" USING btree ("employee_id");