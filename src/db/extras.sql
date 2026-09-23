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

-- Bỏ ràng buộc (kind_code, version) do Drizzle sinh ở migration 0000.
--
-- Nó mã hoá giả định "một loại = một chuỗi phiên bản" — đúng cái giả định mà
-- cột `code` (migration 0003) sinh ra để bỏ. Giữ nó thì hai báo cáo khác nhau
-- không thể cùng có v1: `duplicate key value violates unique constraint`.
--
-- Đặt ở đây chứ không nối vào 0003 vì 0003 đã chạy; Drizzle không chạy lại
-- migration đã áp dụng, nên phần nối thêm sẽ im lặng không bao giờ thực thi.
ALTER TABLE policy_versions DROP CONSTRAINT IF EXISTS uq_policy_kind_version;

-- ---------------------------------------------------------------------------
-- HAI PHẠM VI ĐỘC QUYỀN, HAI RÀNG BUỘC
-- ---------------------------------------------------------------------------
--
-- Tham số luật và định nghĩa có bản chất KHÁC NHAU, và ràng buộc cũ gộp chung
-- cả hai nên đã chặn mất trường hợp hợp lệ:
--
--   THUẾ  : tại 01/09/2026 chỉ có MỘT biểu thuế TNCN. Hai bản ACTIVE chồng lấn
--           là DỮ LIỆU HỎNG.
--   MẪU IN: phiếu lương và bảng chấm công phải CÙNG tồn tại. Hai bản ACTIVE
--           chồng lấn là chuyện bình thường — chúng là hai thứ khác nhau.
--
-- Cờ exclusive_by_code (sao chép từ policy_kinds lên từng dòng) chọn ràng buộc
-- nào áp dụng. Cờ phải nằm trên chính dòng đó vì EXCLUDE không join được sang
-- bảng khác.
--
-- Khoảng vẫn là [from, to) — nửa mở, nên bản kết thúc 2026-06-30 và bản bắt
-- đầu 2026-07-01 KHÔNG bị coi là chồng lấn.

ALTER TABLE policy_versions DROP CONSTRAINT IF EXISTS excl_policy_active_overlap;
ALTER TABLE policy_versions DROP CONSTRAINT IF EXISTS excl_policy_active_overlap_by_kind;
ALTER TABLE policy_versions DROP CONSTRAINT IF EXISTS excl_policy_active_overlap_by_code;

-- (1) Tham số luật: độc quyền theo KIND
ALTER TABLE policy_versions ADD CONSTRAINT excl_policy_active_overlap_by_kind
  EXCLUDE USING gist (
    kind_code WITH =,
    daterange(effective_from::date, effective_to::date, '[)') WITH &&
  ) WHERE (status = 'ACTIVE' AND exclusive_by_code = false);

-- (2) Mẫu in / báo cáo: độc quyền theo (KIND, CODE) — nhiều mã cùng ACTIVE được
ALTER TABLE policy_versions ADD CONSTRAINT excl_policy_active_overlap_by_code
  EXCLUDE USING gist (
    kind_code WITH =,
    code WITH =,
    daterange(effective_from::date, effective_to::date, '[)') WITH &&
  ) WHERE (status = 'ACTIVE' AND exclusive_by_code = true);

COMMENT ON CONSTRAINT excl_policy_active_overlap_by_kind ON policy_versions IS
  'Tham so luat: hai ban ACTIVE cung loai khong duoc chong lan [from, to)';
COMMENT ON CONSTRAINT excl_policy_active_overlap_by_code ON policy_versions IS
  'Mau in / bao cao: hai ban ACTIVE cung (loai, ma) khong duoc chong lan [from, to)';
