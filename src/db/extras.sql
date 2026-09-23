-- ============================================================================
-- RÀNG BUỘC BỔ SUNG — những thứ Drizzle ORM chưa diễn đạt được
-- ============================================================================
-- Chạy SAU `drizzle-kit push`. Idempotent: chạy lại bao nhiêu lần cũng được.
--
-- RÀNG BUỘC CHỐNG CHỒNG LẤN (quan trọng nhất trong file này):
--   Hai phiên bản ACTIVE của cùng một loại chính sách KHÔNG ĐƯỢC có khoảng
--   hiệu lực giao nhau. Nếu thiếu ràng buộc này, một ngày nào đó sẽ tồn tại
--   hai mức thuế TNCN cùng áp dụng cho một ngày, và engine sẽ chọn tuỳ ý —
--   sai lệch tiền thuế mà không có lỗi nào được ném ra.
--
--   Ép ở tầng DATABASE chứ không phải application: dù service layer có bug,
--   dù hai request ghi đồng thời, PostgreSQL vẫn từ chối. Đây là loại bất biến
--   không nên tin vào code application.
--
--   Khoảng dùng [from, to) — nửa mở, nên bản kết thúc 2026-06-30 và bản bắt
--   đầu 2026-07-01 KHÔNG bị coi là chồng lấn.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE policy_versions DROP CONSTRAINT IF EXISTS excl_policy_active_overlap;

ALTER TABLE policy_versions ADD CONSTRAINT excl_policy_active_overlap
  EXCLUDE USING gist (
    kind_code WITH =,
    daterange(effective_from::date, effective_to::date, '[)') WITH &&
  ) WHERE (status = 'ACTIVE');

COMMENT ON CONSTRAINT excl_policy_active_overlap ON policy_versions IS
  'Hai ban ACTIVE cung loai khong duoc chong lan khoang hieu luc [from, to)';
