ALTER TABLE "raw_punches" ADD COLUMN "verify_method" varchar(16);--> statement-breakpoint
ALTER TABLE "shift_devices" ADD COLUMN "webhook_key" varchar(64);--> statement-breakpoint
ALTER TABLE "raw_punches" ADD CONSTRAINT "chk_raw_punches_verify_method" CHECK ("raw_punches"."verify_method" IS NULL OR "raw_punches"."verify_method" IN
          ('FACE','FINGERPRINT','CARD','PASSWORD','UNKNOWN'));