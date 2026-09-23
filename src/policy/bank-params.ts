/**
 * ============================================================================
 * LOẠI CHÍNH SÁCH THỨ MƯỜI MỘT — THAM SỐ XUẤT FILE THANH TOÁN NGÂN HÀNG
 * ============================================================================
 *
 * Vì sao thông tin ngân hàng là policy kind chứ không phải hằng số:
 *
 *   • Công ty ĐỔI TÀI KHOẢN trả lương là chuyện xảy ra, và nếu số tài khoản nằm
 *     trong code thì đó là một lần deploy — trong lúc chờ deploy thì kế toán sửa
 *     tay trong file, mất luôn khả năng truy vết.
 *   • Nội dung chuyển khoản ("LUONG T09/2026 NV001") mỗi nơi một kiểu, có nơi
 *     ngân hàng bắt buộc đúng mẫu mới nhận lô.
 *   • Mẫu file của từng ngân hàng được cập nhật định kỳ. Ít nhất phần độ dài STK
 *     tối thiểu, dấu ngăn cách, có BOM hay không — đều đổi được.
 *
 *   Phần KHÔNG nằm ở đây: bố cục cột cố định của từng ngân hàng. Đó là code, vì
 *   nó gắn với cách parse của core banking và đổi nó mà không test lại thì rủi ro
 *   hơn nhiều so với lợi ích.
 */

import { z } from 'zod';

export const BANK_CODES = ['VCB', 'TCB', 'CTG', 'MBB', 'GENERIC'] as const;
export const PAYOUT_FORMATS = ['csv', 'txt'] as const;

/**
 * Biến được thay trong nội dung chuyển khoản.
 *
 * Khai báo rõ danh sách thay vì cho phép `{...}` tự do: một biến gõ sai
 * (`{EMPLOYE_CODE}`) nếu bỏ qua sẽ ra nguyên chuỗi "{EMPLOYE_CODE}" trong nội
 * dung chuyển khoản của 500 người, và ngân hàng vẫn nhận — đến lúc đối chiếu mới
 * thấy.
 */
export const DESCRIPTION_VARS = [
  'EMPLOYEE_CODE',
  'FULL_NAME',
  'PERIOD_MONTH',
  'PERIOD_YEAR',
  'PERIOD',
  'NET_PAY',
] as const;

export const bankPayoutParamsSchema = z
  .object({
    regimeCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/, 'Mã tham số phải VIẾT HOA, không dấu cách'),
    regimeLabel: z.string().min(1),

    bankCode: z.enum(BANK_CODES),

    // --- Bên trả -----------------------------------------------------------
    payerName: z.string().min(1),
    payerAccountNumber: z
      .string()
      .regex(/^\d{6,20}$/, 'Số tài khoản bên trả phải từ 6 đến 20 chữ số'),
    payerBankCode: z.string().min(3),
    payerBranch: z.string().optional(),
    payerTaxCode: z
      .string()
      .regex(/^\d{10}(-\d{3})?$/, 'Mã số thuế phải 10 số, hoặc 10-3 số với đơn vị phụ thuộc')
      .optional(),

    // --- Nội dung chuyển khoản ---------------------------------------------
    /**
     * VD: 'LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}'
     * Sẽ được bỏ dấu và viết hoa trước khi ghi vào file.
     */
    descriptionTemplate: z.string().min(1),

    // --- Kiểm tra và định dạng ---------------------------------------------
    /**
     * Độ dài STK tối thiểu theo ngân hàng. Chặn TRƯỚC khi gửi: một STK thiếu số
     * vẫn sinh được file, vẫn tải lên được, và chỉ nổ ở phía ngân hàng — lúc đó
     * phải làm lại cả lô.
     */
    minAccountLength: z.number().int().min(6).max(20),
    format: z.enum(PAYOUT_FORMATS),
    /** Dấu ngăn cách, chỉ dùng khi format = 'csv'. */
    delimiter: z.string().min(1).max(1).optional(),
    /**
     * Thêm BOM UTF-8. Cần cho Excel tiếng Việt; một số hệ core banking lại từ chối
     * file có BOM. Nên đây là lựa chọn, không phải mặc định ngầm.
     */
    withBom: z.boolean().optional(),
  })
  .superRefine((p, ctx) => {
    // delimiter chỉ có nghĩa với csv. Cho phép khai cùng txt thì không gây lỗi
    // ngay, nhưng nó là dấu hiệu người soạn hiểu sai cấu hình — và cấu hình sai
    // thì nên kêu lúc bấm lưu chứ không phải lúc file ra sai.
    if (p.format !== 'csv' && p.delimiter !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['delimiter'],
        message: 'delimiter chỉ dùng khi format = csv',
      });
    }

    // Mọi biến trong mẫu nội dung phải nằm trong danh sách đã khai báo.
    const used = [...p.descriptionTemplate.matchAll(/\{([A-Z_]+)\}/g)].map((m) => m[1]!);
    const known = new Set<string>(DESCRIPTION_VARS);
    for (const v of used) {
      if (!known.has(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['descriptionTemplate'],
          message:
            `Biến {${v}} không tồn tại. Các biến dùng được: ` +
            [...known].map((k) => `{${k}}`).join(', '),
        });
      }
    }
  });

export type BankPayoutParams = z.infer<typeof bankPayoutParamsSchema>;

export const bankPayoutJsonSchema = {
  type: 'object',
  required: [
    'regimeCode',
    'regimeLabel',
    'bankCode',
    'payerName',
    'payerAccountNumber',
    'payerBankCode',
    'descriptionTemplate',
    'minAccountLength',
    'format',
  ],
  properties: {
    regimeCode: {
      type: 'string',
      title: 'Mã tham số (regimeCode)',
      pattern: '^[A-Z][A-Z0-9_]*$',
      description: 'VD: BANK_VCB, BANK_TCB',
    },
    regimeLabel: { type: 'string', title: 'Tên cấu hình' },
    bankCode: {
      type: 'string',
      title: 'Ngân hàng',
      enum: [...BANK_CODES],
      description: 'GENERIC = mẫu CSV tổng quát, dùng để đối chiếu nội bộ',
    },
    payerName: { type: 'string', title: 'Tên đơn vị trả lương' },
    payerAccountNumber: {
      type: 'string',
      title: 'Số tài khoản trích nợ',
      pattern: '^\\d{6,20}$',
    },
    payerBankCode: {
      type: 'string',
      title: 'Mã ngân hàng trích nợ (NAPAS)',
      description: 'VD: VCBVNVX',
    },
    payerBranch: { type: 'string', title: 'Chi nhánh trích nợ' },
    payerTaxCode: {
      type: 'string',
      title: 'Mã số thuế đơn vị',
      pattern: '^\\d{10}(-\\d{3})?$',
    },
    descriptionTemplate: {
      type: 'string',
      title: 'Mẫu nội dung chuyển khoản',
      description:
        'Biến dùng được: ' +
        DESCRIPTION_VARS.map((v) => `{${v}}`).join(', ') +
        '. VD: LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}',
    },
    minAccountLength: {
      type: 'integer',
      title: 'Độ dài STK tối thiểu',
      minimum: 6,
      maximum: 20,
      description: 'Theo quy định của từng ngân hàng. Chặn trước khi gửi file.',
    },
    format: {
      type: 'string',
      title: 'Định dạng file',
      enum: [...PAYOUT_FORMATS],
      description: 'VCB thường nhận txt cột cố định; các ngân hàng khác nhận csv',
    },
    delimiter: {
      type: 'string',
      title: 'Dấu ngăn cách (chỉ CSV)',
      maxLength: 1,
      description: 'Mặc định dấu phẩy. Một số nơi dùng chấm phẩy.',
    },
    withBom: {
      type: 'boolean',
      title: 'Thêm BOM UTF-8',
      description: 'Cần cho Excel tiếng Việt; một số core banking lại từ chối file có BOM.',
    },
  },
} as const;

/** Bốn cấu hình seed — tài khoản công ty là số GIẢ, phải thay trước khi dùng thật. */
export const SEED_BANK_PAYOUT_VN: BankPayoutParams[] = [
  {
    regimeCode: 'BANK_VCB',
    regimeLabel: 'Vietcombank — UNC cột cố định',
    bankCode: 'VCB',
    payerName: 'CONG TY CO PHAN AMIS',
    payerAccountNumber: '0011001234567',
    payerBankCode: 'VCBVNVX',
    payerBranch: 'So Giao Dich TP.HCM',
    payerTaxCode: '0312345678',
    descriptionTemplate: 'LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}',
    minAccountLength: 6,
    format: 'txt',
    withBom: false,
  },
  {
    regimeCode: 'BANK_TCB',
    regimeLabel: 'Techcombank — CSV',
    bankCode: 'TCB',
    payerName: 'CONG TY CO PHAN AMIS',
    payerAccountNumber: '19031234567015',
    payerBankCode: 'VTCBVNVX',
    payerTaxCode: '0312345678',
    descriptionTemplate: 'LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}',
    minAccountLength: 6,
    format: 'csv',
    delimiter: ',',
    withBom: true,
  },
  {
    regimeCode: 'BANK_CTG',
    regimeLabel: 'VietinBank — CSV',
    bankCode: 'CTG',
    payerName: 'CONG TY CO PHAN AMIS',
    payerAccountNumber: '102010001234567',
    payerBankCode: 'ICBVVNVX',
    payerTaxCode: '0312345678',
    descriptionTemplate: 'LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}',
    minAccountLength: 9,
    format: 'csv',
    delimiter: ',',
    withBom: true,
  },
  {
    regimeCode: 'BANK_MBB',
    regimeLabel: 'MB Bank — CSV',
    bankCode: 'MBB',
    payerName: 'CONG TY CO PHAN AMIS',
    payerAccountNumber: '0123456789',
    payerBankCode: 'MSCBVNVX',
    payerTaxCode: '0312345678',
    descriptionTemplate: 'LUONG T{PERIOD_MONTH}/{PERIOD_YEAR} {EMPLOYEE_CODE}',
    minAccountLength: 6,
    format: 'csv',
    delimiter: ',',
    withBom: true,
  },
];
