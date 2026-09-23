/**
 * ============================================================================
 * ÁNH XẠ KẾ TOÁN (GL_MAP) — loại chính sách thứ bảy
 * ============================================================================
 *
 * Bộ phận nào hạch toán vào tài khoản chi phí nào là THÔNG SỐ, không phải code:
 * công ty đổi sơ đồ tổ chức, thêm bộ phận, hay chuyển chi phí sản xuất từ 154
 * sang 627 là chuyện xảy ra thường xuyên và không cần một lần deploy.
 *
 * Còn SỐ HIỆU tài khoản nghiệp vụ (334, 3383, 3335, 1121…) thì cố định trong
 * engine — đổi chúng giữa kỳ sẽ làm sổ cái không so sánh được với báo cáo đã nộp.
 */

import { z } from 'zod';

/** Tài khoản nghiệp vụ bắt buộc phải có. Thiếu một cái là không ghi sổ được. */
export const REQUIRED_ACCOUNTS = [
  'payableSalary', // 334  Phải trả người lao động
  'siSocial', // 3383 BHXH
  'siHealth', // 3384 BHYT
  'siUnemployment', // 3386 BHTN
  'siAccident', // 3388 Bảo hiểm tai nạn (phía doanh nghiệp)
  'pitPayable', // 3335 Thuế TNCN phải nộp
  'bankVnd', // 1121 Tiền gửi ngân hàng VND
  'otherPayable', // 338  Phải trả phải nộp khác
] as const;
export type RequiredAccountKey = (typeof REQUIRED_ACCOUNTS)[number];

export const ACCOUNT_LABELS: Record<RequiredAccountKey, string> = {
  payableSalary: 'Phải trả người lao động (334)',
  siSocial: 'BHXH (3383)',
  siHealth: 'BHYT (3384)',
  siUnemployment: 'BHTN (3386)',
  siAccident: 'BH tai nạn lao động (3388)',
  pitPayable: 'Thuế TNCN phải nộp (3335)',
  bankVnd: 'Tiền gửi ngân hàng VND (1121)',
  otherPayable: 'Phải trả phải nộp khác (338)',
};

const ACCOUNT_RE = /^\d{3,8}$/;
const ACCOUNT_MESSAGE =
  'Số hiệu tài khoản theo Thông tư 200 là 3–8 chữ số, ví dụ 334, 6422, 1121.';

export const glMapParamsSchema = z
  .object({
    regimeCode: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    regimeLabel: z.string().min(1),
    /** Tài khoản nghiệp vụ cố định về mặt ý nghĩa, ánh xạ tới số hiệu cụ thể. */
    accounts: z.record(z.string().regex(ACCOUNT_RE, ACCOUNT_MESSAGE)),
    /**
     * Bộ phận → tài khoản CHI PHÍ.
     *
     * Đây là phần thay đổi theo cơ cấu tổ chức, nên nó là dữ liệu.
     */
    departmentAccounts: z.record(z.string().regex(ACCOUNT_RE, ACCOUNT_MESSAGE)),
    /** Dùng khi bộ phận chưa có trong danh sách trên. */
    defaultExpenseAccount: z.string().regex(ACCOUNT_RE, ACCOUNT_MESSAGE),
    /**
     * Hạch toán tạm ứng / khấu trừ khác vào đâu. Không có chỗ này thì khoản
     * tạm ứng sẽ bị gộp vào "phải trả khác" một cách mơ hồ.
     */
    advanceAccount: z.string().regex(ACCOUNT_RE, ACCOUNT_MESSAGE),
  })
  .superRefine((p, ctx) => {
    // --- Phải đủ MỌI tài khoản nghiệp vụ --------------------------------
    for (const key of REQUIRED_ACCOUNTS) {
      if (!p.accounts[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accounts', key],
          message: `Thiếu tài khoản '${key}' (${ACCOUNT_LABELS[key]}). Không có nó thì không ghi được bút toán lương.`,
        });
      }
    }

    // --- Số hiệu không được trùng ý nghĩa --------------------------------
    // 334 mà trỏ tới cùng số hiệu với 3335 thì bút toán tự triệt tiêu và sổ
    // cái trông vẫn cân — loại lỗi không thể phát hiện bằng đối chiếu tổng.
    const seen = new Map<string, string>();
    for (const [key, code] of Object.entries(p.accounts)) {
      const prev = seen.get(code);
      if (prev) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accounts', key],
          message: `'${key}' và '${prev}' cùng trỏ tới tài khoản ${code}. Hai nghiệp vụ khác nhau dùng chung một tài khoản sẽ làm bút toán tự triệt tiêu mà sổ vẫn cân.`,
        });
      }
      seen.set(code, key);
    }

    // --- Phải có ít nhất một bộ phận được ánh xạ -------------------------
    if (Object.keys(p.departmentAccounts).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['departmentAccounts'],
        message:
          'Chưa ánh xạ bộ phận nào. Mọi chi phí sẽ dồn vào tài khoản mặc định và mất khả năng phân tích theo bộ phận.',
      });
    }
  });

export type GlMapParams = z.infer<typeof glMapParamsSchema>;

export const glMapJsonSchema = {
  type: 'object',
  required: [
    'regimeCode',
    'regimeLabel',
    'accounts',
    'departmentAccounts',
    'defaultExpenseAccount',
    'advanceAccount',
  ],
  properties: {
    regimeCode: { type: 'string', title: 'Mã chế độ', pattern: '^[A-Z][A-Z0-9_]*$' },
    regimeLabel: { type: 'string', title: 'Tên' },
    accounts: {
      type: 'object',
      title: 'Tài khoản nghiệp vụ',
      description: 'Số hiệu theo Thông tư 200/2014',
      additionalProperties: { type: 'string', pattern: '^\\d{3,8}$' },
    },
    departmentAccounts: {
      type: 'object',
      title: 'Bộ phận → tài khoản chi phí',
      description: 'Ví dụ: Kỹ thuật → 6422, Sản xuất → 154',
      additionalProperties: { type: 'string', pattern: '^\\d{3,8}$' },
    },
    defaultExpenseAccount: {
      type: 'string',
      title: 'Tài khoản chi phí mặc định',
      pattern: '^\\d{3,8}$',
    },
    advanceAccount: {
      type: 'string',
      title: 'Tài khoản tạm ứng / khấu trừ khác',
      pattern: '^\\d{3,8}$',
    },
  },
} as const;

export const SEED_GL_MAP_VN: GlMapParams = {
  regimeCode: 'GL_MAP_VN_TT200',
  regimeLabel: 'Ánh xạ kế toán VN (Thông tư 200/2014)',
  accounts: {
    payableSalary: '334',
    siSocial: '3383',
    siHealth: '3384',
    siUnemployment: '3386',
    siAccident: '3388',
    pitPayable: '3335',
    bankVnd: '1121',
    otherPayable: '338',
  },
  departmentAccounts: {
    'Kỹ thuật': '6422',
    'Kinh doanh': '6421',
    'Nhân sự': '6422',
    'Kế toán': '6422',
    'Sản xuất': '154',
  },
  defaultExpenseAccount: '6422',
  advanceAccount: '141',
};
