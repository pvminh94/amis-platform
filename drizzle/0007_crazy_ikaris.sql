CREATE TABLE IF NOT EXISTS "daily_attendance" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" varchar(32) NOT NULL,
	"work_date" date NOT NULL,
	"shift_code" varchar(32) NOT NULL,
	"shift_policy_version_id" uuid,
	"day_kind" varchar(16) NOT NULL,
	"status" varchar(24) NOT NULL,
	"worked_minutes" integer DEFAULT 0 NOT NULL,
	"standard_days" numeric(8, 3) DEFAULT '0' NOT NULL,
	"night_minutes" integer DEFAULT 0 NOT NULL,
	"late_minutes" integer DEFAULT 0 NOT NULL,
	"early_leave_minutes" integer DEFAULT 0 NOT NULL,
	"absent_minutes" integer DEFAULT 0 NOT NULL,
	"ot_weekday_minutes" integer DEFAULT 0 NOT NULL,
	"ot_weekend_minutes" integer DEFAULT 0 NOT NULL,
	"ot_holiday_minutes" integer DEFAULT 0 NOT NULL,
	"ot_night_minutes" integer DEFAULT 0 NOT NULL,
	"regularized_minutes" integer DEFAULT 0 NOT NULL,
	"punch_count" integer DEFAULT 0 NOT NULL,
	"check_in_at" timestamp with time zone,
	"check_out_at" timestamp with time zone,
	"segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rejected_punches" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"pairing_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_daily_attendance_person_day" UNIQUE("employee_code","work_date"),
	CONSTRAINT "chk_daily_attendance_day_kind" CHECK ("daily_attendance"."day_kind" IN ('WORKING_DAY','WEEKLY_REST','PUBLIC_HOLIDAY','PAID_LEAVE')),
	CONSTRAINT "chk_daily_attendance_status" CHECK ("daily_attendance"."status" IN ('PRESENT','LATE','HALF_DAY','ABSENT','MISSING_PUNCH','WEEKLY_OFF','HOLIDAY_OFF','PAID_LEAVE')),
	CONSTRAINT "chk_daily_attendance_non_negative" CHECK ("daily_attendance"."worked_minutes" >= 0 AND "daily_attendance"."night_minutes" >= 0 AND "daily_attendance"."late_minutes" >= 0
           AND "daily_attendance"."early_leave_minutes" >= 0 AND "daily_attendance"."absent_minutes" >= 0
           AND "daily_attendance"."ot_weekday_minutes" >= 0 AND "daily_attendance"."ot_weekend_minutes" >= 0
           AND "daily_attendance"."ot_holiday_minutes" >= 0 AND "daily_attendance"."ot_night_minutes" >= 0
           AND "daily_attendance"."regularized_minutes" >= 0 AND "daily_attendance"."punch_count" >= 0),
	CONSTRAINT "chk_daily_attendance_night" CHECK ("daily_attendance"."night_minutes" <= "daily_attendance"."worked_minutes"),
	CONSTRAINT "chk_daily_attendance_days" CHECK ("daily_attendance"."standard_days" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employee_shifts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" varchar(32) NOT NULL,
	"work_date" date NOT NULL,
	"shift_code" varchar(32),
	"rotation_code" varchar(32),
	"anchor_date" date,
	"team_index" integer,
	"leave_kind" varchar(32),
	"note" varchar(240),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_employee_shifts_person_day" UNIQUE("employee_code","work_date"),
	CONSTRAINT "chk_employee_shifts_one_mode" CHECK (("employee_shifts"."shift_code" IS NULL) <> ("employee_shifts"."rotation_code" IS NULL)),
	CONSTRAINT "chk_employee_shifts_rotation" CHECK ("employee_shifts"."rotation_code" IS NULL OR ("employee_shifts"."anchor_date" IS NOT NULL AND "employee_shifts"."team_index" IS NOT NULL)),
	CONSTRAINT "chk_employee_shifts_team" CHECK ("employee_shifts"."team_index" IS NULL OR "employee_shifts"."team_index" >= 0),
	CONSTRAINT "chk_employee_shifts_date" CHECK ("employee_shifts"."work_date" BETWEEN '2000-01-01' AND '2100-01-01')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "public_holidays" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"holiday_date" date NOT NULL,
	"name_vi" varchar(160) NOT NULL,
	"legal_ref" varchar(160),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_public_holidays_date" UNIQUE("holiday_date"),
	CONSTRAINT "chk_public_holidays_date" CHECK ("public_holidays"."holiday_date" BETWEEN '2000-01-01' AND '2100-01-01')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "raw_punches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"employee_code" varchar(32) NOT NULL,
	"device_serial" varchar(64) NOT NULL,
	"punched_at" timestamp with time zone NOT NULL,
	"direction" varchar(3),
	"source" varchar(16) DEFAULT 'DEVICE' NOT NULL,
	"latitude" double precision,
	"longitude" double precision,
	"accuracy_meters" integer,
	"bssid" varchar(32),
	"device_id" varchar(120),
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_raw_punches_once" UNIQUE("employee_code","device_serial","punched_at"),
	CONSTRAINT "chk_raw_punches_direction" CHECK ("raw_punches"."direction" IS NULL OR "raw_punches"."direction" IN ('IN','OUT')),
	CONSTRAINT "chk_raw_punches_source" CHECK ("raw_punches"."source" IN ('DEVICE','ADMS','MOBILE','MANUAL')),
	CONSTRAINT "chk_raw_punches_coords" CHECK ("raw_punches"."latitude" IS NULL OR ("raw_punches"."latitude" BETWEEN -90 AND 90 AND "raw_punches"."longitude" BETWEEN -180 AND 180)),
	CONSTRAINT "chk_raw_punches_accuracy" CHECK ("raw_punches"."accuracy_meters" IS NULL OR "raw_punches"."accuracy_meters" > 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shift_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"serial" varchar(64) NOT NULL,
	"model" varchar(64),
	"protocol" varchar(24) NOT NULL,
	"location" varchar(120),
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_shift_devices_serial" UNIQUE("serial"),
	CONSTRAINT "chk_shift_devices_protocol" CHECK ("shift_devices"."protocol" IN ('HIK_ISAPI','ZK_ADMS','RONALD_TCP','MOBILE','MANUAL'))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "daily_attendance" ADD CONSTRAINT "daily_attendance_employee_code_employees_employee_code_fk" FOREIGN KEY ("employee_code") REFERENCES "public"."employees"("employee_code") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "employee_shifts" ADD CONSTRAINT "employee_shifts_employee_code_employees_employee_code_fk" FOREIGN KEY ("employee_code") REFERENCES "public"."employees"("employee_code") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_punches" ADD CONSTRAINT "raw_punches_employee_code_employees_employee_code_fk" FOREIGN KEY ("employee_code") REFERENCES "public"."employees"("employee_code") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "raw_punches" ADD CONSTRAINT "raw_punches_device_serial_shift_devices_serial_fk" FOREIGN KEY ("device_serial") REFERENCES "public"."shift_devices"("serial") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daily_attendance_date" ON "daily_attendance" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daily_attendance_status" ON "daily_attendance" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_daily_attendance_month" ON "daily_attendance" USING btree (date_trunc('month', "work_date"::timestamp));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_employee_shifts_date" ON "employee_shifts" USING btree ("work_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_public_holidays_date" ON "public_holidays" USING btree ("holiday_date");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_punches_employee_time" ON "raw_punches" USING btree ("employee_code","punched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_raw_punches_device_time" ON "raw_punches" USING btree ("device_serial","punched_at");