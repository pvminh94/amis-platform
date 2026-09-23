ALTER TABLE "raw_punches" ADD COLUMN "is_mock_location" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_punches" ADD COLUMN "geo_status" varchar(16);--> statement-breakpoint
ALTER TABLE "raw_punches" ADD COLUMN "geo_distance_m" integer;--> statement-breakpoint
ALTER TABLE "raw_punches" ADD COLUMN "geo_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_punches" ADD COLUMN "liveness_score" integer;--> statement-breakpoint
ALTER TABLE "raw_punches" ADD COLUMN "liveness_passed" boolean;--> statement-breakpoint
ALTER TABLE "raw_punches" ADD COLUMN "liveness_attack" varchar(20);--> statement-breakpoint
ALTER TABLE "shift_devices" ADD COLUMN "site_code" varchar(32);--> statement-breakpoint
ALTER TABLE "shift_devices" ADD COLUMN "device_type" varchar(12) DEFAULT 'TERMINAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "raw_punches" ADD CONSTRAINT "chk_raw_punches_geo" CHECK ("raw_punches"."geo_status" IS NULL OR "raw_punches"."geo_status" IN
          ('TRUSTED','REVIEW','REJECTED','NO_FENCE','NO_GPS'));--> statement-breakpoint
ALTER TABLE "raw_punches" ADD CONSTRAINT "chk_raw_punches_liveness" CHECK (("raw_punches"."liveness_score" IS NULL OR ("raw_punches"."liveness_score" >= 0 AND "raw_punches"."liveness_score" <= 100))
          AND ("raw_punches"."liveness_attack" IS NULL OR "raw_punches"."liveness_attack" IN
               ('PRINT_2D','SCREEN_REPLAY','STATIC_REPLAY','NO_FACE')));--> statement-breakpoint
ALTER TABLE "shift_devices" ADD CONSTRAINT "chk_shift_devices_type" CHECK ("shift_devices"."device_type" IN ('TERMINAL','MOBILE'));