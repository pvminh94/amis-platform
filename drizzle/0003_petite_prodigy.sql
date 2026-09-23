ALTER TABLE "policy_kinds" ADD COLUMN "exclusive_by_code" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "code" varchar(64) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD COLUMN "exclusive_by_code" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "policy_versions" ADD CONSTRAINT "uq_policy_kind_code_version" UNIQUE("kind_code","code","version");--> statement-breakpoint
-- BACKFILL cho dữ liệu đã có. Không có đoạn này thì mọi phiên bản cũ mang
-- code = '' và resolvePolicy theo mã sẽ không tìm thấy gì — hệ thống "chạy
-- được" nhưng trả về NOT_RESOLVABLE cho toàn bộ chính sách.
UPDATE "policy_versions" SET "code" = COALESCE("params"->>'regimeCode', '') WHERE "code" = '';--> statement-breakpoint
UPDATE "policy_kinds" SET "exclusive_by_code" = ("code" IN ('PRINT', 'REPORT_DEF'));--> statement-breakpoint
UPDATE "policy_versions" pv SET "exclusive_by_code" = k."exclusive_by_code"
  FROM "policy_kinds" k WHERE k."code" = pv."kind_code";
