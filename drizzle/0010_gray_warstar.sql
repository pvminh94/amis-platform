-- Thêm cột lưu NỘI DUNG file thanh toán.
--
-- KHÔNG dùng một lệnh `ADD COLUMN ... text NOT NULL`: bảng đã có dữ liệu (các lô
-- đã xuất) và PostgreSQL không điền được giá trị cho các dòng cũ — lỗi 2202H/23502
-- ngay tại đây. Ba bước: thêm nullable, điền cho dòng cũ, rồi mới siết NOT NULL.
--
-- Các lô cũ điền chuỗi rỗng và checksum của chúng KHÔNG khớp với rỗng — đó là chủ
-- ý: một lô sinh ra trước khi hệ thống lưu nội dung thì phải hiện rõ là không tái
-- tạo được, chứ không được trông như hợp lệ.
ALTER TABLE "bank_payment_batches" ADD COLUMN IF NOT EXISTS "content" text;--> statement-breakpoint
UPDATE "bank_payment_batches" SET "content" = '' WHERE "content" IS NULL;--> statement-breakpoint
ALTER TABLE "bank_payment_batches" ALTER COLUMN "content" SET NOT NULL;
