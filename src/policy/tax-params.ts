/**
 * ============================================================================
 * THAM SỐ THUẾ TNCN VIỆT NAM — định nghĩa bằng Zod, không hardcode
 * ============================================================================
 *
 * Tại sao dùng Zod chứ không phải JSON Schema thuần:
 *   1. Zod cho ra TypeScript type → engine tính thuế có type-safety thật
 *   2. Zod cho ra JSON Schema (qua zod-to-json-schema) → TỰ SINH form trên UI
 *   3. Validate được những ràng buộc NGHIỆP VỤ mà JSON Schema không diễn đạt
 *      nổi — ví dụ "bậc thuế phải tăng dần", "số trừ nhanh phải khớp công thức"
 *
 * Điểm 3 là chỗ đáng giá nhất. Một file cấu hình thuế sai (bậc 3 nhỏ hơn bậc 2)
 * sẽ cho ra số thuế âm hoặc nhảy cóc. Chặn ngay lúc lưu, không phải lúc tính lương.
 */

import { z } from 'zod';

/** Đơn vị: đồng Việt Nam, số nguyên. Không dùng float cho tiền. */
const vnd = z.number().int('Phải là số nguyên (VND)');
const nonNegativeVnd = vnd.nonnegative('Không được âm');

/** Tỷ lệ 0–1, cho phép 4 chữ số thập phân (0.0525 = 5,25%). */
const rate = z
  .number()
  .min(0, 'Thuế suất không được âm')
  .max(1, 'Thuế suất không được vượt 100%');

/**
 * Một bậc thuế luỹ tiến.
 *   upto            — ngưỡng trên của bậc (VND). null = bậc cuối, không giới hạn
 *   rate            — thuế suất
 *   quickDeduction  — số trừ nhanh, để tính tắt: thuế = TNTT × rate − quick
 */
export const taxBracketSchema = z
  .object({
    upto: nonNegativeVnd.nullable().describe('Ngưỡng trên bậc (VND). null = không giới hạn'),
    rate: rate.describe('Thuế suất (0.05 = 5%)'),
    quickDeduction: nonNegativeVnd.describe('Số trừ nhanh (VND)'),
  })
  .strict();

export type TaxBracket = z.infer<typeof taxBracketSchema>;

export const vnPitParamsSchema = z
  .object({
    /** Tên chế độ, để hiển thị và ghi vào policySnapshot. */
    regimeCode: z.string().min(1).max(32),
    regimeLabel: z.string().min(1).max(200),

    /** Biểu thuế luỹ tiến từng phần, sắp theo ngưỡng tăng dần. */
    brackets: z.array(taxBracketSchema).min(1, 'Phải có ít nhất một bậc thuế'),

    /** Giảm trừ gia cảnh cho bản thân người nộp thuế (VND/tháng). */
    selfDeduction: nonNegativeVnd,

    /** Giảm trừ cho mỗi người phụ thuộc (VND/tháng/người). */
    dependentDeduction: nonNegativeVnd,

    /** Trần trừ bảo hiểm hưu trí tự nguyện (VND/tháng). */
    voluntaryPensionCapMonthly: nonNegativeVnd,

    /** Trần thu nhập miễn thuế với khoản ăn giữa ca (VND/tháng). */
    // KHÔNG dùng .default(0) ở đây. Với z.infer, một trường có default sẽ có
    // kiểu INPUT khác kiểu OUTPUT, và z.ZodType<T> (dùng T cho cả hai) sẽ báo
    // lỗi variance ở mọi chỗ truyền validator. Quan trọng hơn về mặt nghiệp
    // vụ: tham số pháp lý không nên có giá trị mặc định âm thầm — thiếu thì
    // bắt người dùng khai báo rõ.
    exemptMealCapMonthly: nonNegativeVnd,
  })
  .strict()
  // ---------------------------------------------------------------------------
  // RÀNG BUỘC NGHIỆP VỤ — phần JSON Schema không làm được
  // ---------------------------------------------------------------------------
  .superRefine((p, ctx) => {
    const { brackets } = p;

    // 1. Chỉ bậc CUỐI CÙNG được để upto = null
    brackets.forEach((b, i) => {
      if (b.upto === null && i !== brackets.length - 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['brackets', i, 'upto'],
          message: 'Chỉ bậc cuối cùng mới được để ngưỡng = không giới hạn',
        });
      }
    });

    // 2. Ngưỡng phải TĂNG DẦN. Nếu bậc 3 ≤ bậc 2 thì khoảng tính bị âm và
    //    thuế ra số âm — lỗi cực khó truy nếu để lọt tới lúc tính lương.
    for (let i = 1; i < brackets.length; i++) {
      const prev = brackets[i - 1]?.upto;
      const cur = brackets[i]?.upto;
      if (prev !== null && prev !== undefined && cur !== null && cur !== undefined && cur <= prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['brackets', i, 'upto'],
          message: `Ngưỡng bậc ${i + 1} (${cur.toLocaleString('vi-VN')}) phải lớn hơn bậc ${i} (${prev.toLocaleString('vi-VN')})`,
        });
      }
    }

    // 3. Thuế suất phải KHÔNG GIẢM theo bậc (luỹ tiến). Biểu thuế mà bậc cao
    //    lại chịu suất thấp hơn là biểu thuế sai.
    for (let i = 1; i < brackets.length; i++) {
      const prev = brackets[i - 1];
      const cur = brackets[i];
      if (prev && cur && cur.rate < prev.rate) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['brackets', i, 'rate'],
          message: `Thuế suất bậc ${i + 1} không được thấp hơn bậc ${i} (biểu luỹ tiến)`,
        });
      }
    }

    // 4. Số trừ nhanh PHẢI khớp công thức, không cho nhập tuỳ ý.
    //    quick[i] = quick[i-1] + upto[i-1] × (rate[i] − rate[i-1])
    //    Nếu để người dùng gõ tay một con số lệch, hai cách tính (từng phần
    //    và tính tắt) sẽ cho hai kết quả khác nhau — và không ai biết tin cái nào.
    for (let i = 1; i < brackets.length; i++) {
      const prev = brackets[i - 1];
      const cur = brackets[i];
      if (!prev || !cur || prev.upto === null) continue;
      const expected = Math.round(prev.quickDeduction + prev.upto * (cur.rate - prev.rate));
      // Chênh 1đ do làm tròn là chấp nhận được
      if (Math.abs(cur.quickDeduction - expected) > 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['brackets', i, 'quickDeduction'],
          message: `Số trừ nhanh bậc ${i + 1} phải là ${expected.toLocaleString('vi-VN')}đ (đang là ${cur.quickDeduction.toLocaleString('vi-VN')}đ). Công thức: trừ nhanh bậc trước + ngưỡng bậc trước × chênh lệch thuế suất.`,
        });
      }
    }
  });

export type VnPitParams = z.infer<typeof vnPitParamsSchema>;

/**
 * JSON Schema tương ứng — dùng để TỰ SINH form chỉnh sửa trên giao diện.
 * Viết tay một lần ở đây, mọi màn hình cấu hình thuế đều dựng từ nó.
 * Thêm loại chính sách mới = thêm một schema, không phải viết form mới.
 */
export const vnPitJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Tham số thuế TNCN Việt Nam',
  type: 'object',
  required: [
    'regimeCode',
    'regimeLabel',
    'brackets',
    'selfDeduction',
    'dependentDeduction',
    'voluntaryPensionCapMonthly',
  ],
  properties: {
    regimeCode: { type: 'string', title: 'Mã chế độ', maxLength: 32 },
    regimeLabel: { type: 'string', title: 'Tên chế độ', maxLength: 200 },
    selfDeduction: {
      type: 'integer',
      title: 'Giảm trừ bản thân (VND/tháng)',
      minimum: 0,
    },
    dependentDeduction: {
      type: 'integer',
      title: 'Giảm trừ mỗi người phụ thuộc (VND/tháng)',
      minimum: 0,
    },
    voluntaryPensionCapMonthly: {
      type: 'integer',
      title: 'Trần hưu trí tự nguyện (VND/tháng)',
      minimum: 0,
    },
    exemptMealCapMonthly: {
      type: 'integer',
      title: 'Trần miễn thuế ăn giữa ca (VND/tháng)',
      minimum: 0,
    },
    brackets: {
      type: 'array',
      title: 'Biểu thuế luỹ tiến',
      minItems: 1,
      items: {
        type: 'object',
        required: ['upto', 'rate', 'quickDeduction'],
        properties: {
          upto: {
            type: ['integer', 'null'],
            title: 'Ngưỡng trên (VND)',
            description: 'Để trống ở bậc cuối = không giới hạn',
          },
          rate: { type: 'number', title: 'Thuế suất', minimum: 0, maximum: 1 },
          quickDeduction: { type: 'integer', title: 'Số trừ nhanh (VND)', minimum: 0 },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// HAI CHẾ ĐỘ THUẾ CÓ THẬT — làm dữ liệu mẫu, KHÔNG phải hằng số trong engine
// ---------------------------------------------------------------------------
// Engine đọc từ policy_versions. Hai bộ dưới đây chỉ để SEED ban đầu; sau đó
// người dùng sửa trực tiếp trên giao diện.

/**
 * Biểu 7 bậc theo Thông tư 111/2013/TT-BTC — áp dụng đến 31/12/2025.
 * Giảm trừ 11.000.000 / 4.400.000 theo Nghị quyết 954/2020/UBTVQH14.
 */
export const SEED_LEGACY_7B: VnPitParams = {
  regimeCode: 'LEGACY_7B',
  regimeLabel: 'Biểu 7 bậc (TT 111/2013) — đến 31/12/2025',
  brackets: [
    { upto: 5_000_000, rate: 0.05, quickDeduction: 0 },
    { upto: 10_000_000, rate: 0.1, quickDeduction: 250_000 },
    { upto: 18_000_000, rate: 0.15, quickDeduction: 750_000 },
    { upto: 32_000_000, rate: 0.2, quickDeduction: 1_650_000 },
    { upto: 52_000_000, rate: 0.25, quickDeduction: 3_250_000 },
    { upto: 80_000_000, rate: 0.3, quickDeduction: 5_850_000 },
    { upto: null, rate: 0.35, quickDeduction: 9_850_000 },
  ],
  selfDeduction: 11_000_000,
  dependentDeduction: 4_400_000,
  voluntaryPensionCapMonthly: 1_000_000,
  exemptMealCapMonthly: 730_000,
};

/**
 * Biểu 5 bậc theo Luật Thuế TNCN (sửa đổi) 109/2025/QH15.
 * Giảm trừ 15.500.000 / 6.200.000 theo Nghị quyết 110/2025/UBTVQH15
 * (hiệu lực 01/01/2026, thay Nghị quyết 954/2020).
 *
 * LƯU Ý VỀ NGÀY HIỆU LỰC CỦA BIỂU 5 BẬC: các nguồn chính thống mâu thuẫn
 * giữa 01/01/2026 và 01/07/2026. Riêng mức giảm trừ 15,5tr/6,2tr thì rõ ràng
 * là 01/01/2026. Đây chính là lý do hệ thống cho phép CẤU HÌNH NGÀY:
 * khi có văn bản chính thức, người dùng đổi effective_from trên giao diện
 * chứ không phải chờ lập trình viên sửa code.
 */
export const SEED_VN_2026_5B: VnPitParams = {
  regimeCode: 'VN_2026_5B',
  regimeLabel: 'Biểu 5 bậc (Luật 109/2025/QH15) — từ 01/07/2026',
  brackets: [
    { upto: 10_000_000, rate: 0.05, quickDeduction: 0 },
    { upto: 30_000_000, rate: 0.1, quickDeduction: 500_000 },
    { upto: 60_000_000, rate: 0.2, quickDeduction: 3_500_000 },
    { upto: 100_000_000, rate: 0.3, quickDeduction: 9_500_000 },
    { upto: null, rate: 0.35, quickDeduction: 14_500_000 },
  ],
  selfDeduction: 15_500_000,
  dependentDeduction: 6_200_000,
  voluntaryPensionCapMonthly: 1_000_000,
  exemptMealCapMonthly: 730_000,
};

/**
 * Chế độ cầu nối nửa đầu 2026: giảm trừ MỚI nhưng biểu thuế VẪN 7 bậc.
 * Tồn tại vì hai văn bản có hiệu lực lệch nhau (NQ 110/2025 từ 01/01, biểu
 * 5 bậc có thể từ 01/07). Nếu thực tế không có khoảng này, xoá trên giao diện.
 */
export const SEED_BRIDGE_2026H1: VnPitParams = {
  regimeCode: 'BRIDGE_2026H1',
  regimeLabel: 'Giảm trừ mới (NQ 110/2025) + biểu 7 bậc — 01/01–30/06/2026',
  brackets: SEED_LEGACY_7B.brackets,
  selfDeduction: 15_500_000,
  dependentDeduction: 6_200_000,
  voluntaryPensionCapMonthly: 1_000_000,
  exemptMealCapMonthly: 730_000,
};
