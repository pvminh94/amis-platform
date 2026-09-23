/**
 * ============================================================================
 * NGƯỠNG DUYỆT — ai phải duyệt cái gì, ở mức nào
 * ============================================================================
 *
 * Loại chính sách thứ tư. Đây là thứ mà ở ERPNext/Odoo người ta phải vào
 * Workflow Designer kéo thả; ở đây nó là MỘT BẢNG trong database, sửa qua
 * form tự sinh.
 *
 * NGỮ NGHĨA — CHUỖI DUYỆT, KHÔNG PHẢI MỘT NGƯỜI:
 *   Đơn nghỉ 5 ngày với ngưỡng [≤3: Quản lý trực tiếp, ≤10: Trưởng phòng,
 *   còn lại: Giám đốc nhân sự] thì cần CẢ Quản lý trực tiếp LẪN Trưởng phòng.
 *
 *   Đây là lựa chọn có chủ ý. Cách kia ("chỉ người ở bậc khớp") nghe hợp lý
 *   nhưng tạo ra lỗ hổng: một đơn 10 ngày sẽ bỏ qua quản lý trực tiếp —
 *   người duy nhất biết nhân viên đó có thực sự nghỉ được hay không. Chuỗi
 *   duyệt dài hơn nhưng không có lỗ hổng.
 *
 * Machine trạng thái (DRAFT → SUBMITTED → APPROVED…) KHÔNG nằm ở đây. Đó là
 * việc của Phase 4 (workflow designer). File này chỉ trả lời "cần những ai".
 */

import { z } from 'zod';

const IDENT = /^[A-Z][A-Z0-9_]*$/;

export const approvalLevelSchema = z
  .object({
    code: z
      .string()
      .regex(IDENT, 'Mã cấp duyệt phải là chữ HOA, số và gạch dưới, bắt đầu bằng chữ'),
    name: z.string().min(1, 'Phải có tên cấp duyệt').max(80),
    /** Thứ bậc. Nhỏ hơn = thấp hơn trong chuỗi duyệt. */
    order: z.number().int('Thứ bậc phải là số nguyên').min(1, 'Thứ bậc bắt đầu từ 1'),
  })
  .strict();

export type ApprovalLevel = z.infer<typeof approvalLevelSchema>;

export const approvalThresholdSchema = z
  .object({
    /**
     * Ngưỡng trên (KHÔNG bao gồm). null = không giới hạn, phải là bậc cuối.
     * Đơn vị do `unit` của luật quy định (ngày, giờ, VND…).
     */
    upto: z.number().positive('Ngưỡng phải dương').nullable(),
    /** Mã cấp duyệt áp dụng. Phải tồn tại trong `levels`. */
    level: z.string(),
  })
  .strict();

export type ApprovalThreshold = z.infer<typeof approvalThresholdSchema>;

export const approvalRuleSchema = z
  .object({
    /** Loại chứng từ: LEAVE, BUSINESS_TRIP, EXPENSE, PAYRUN… */
    docType: z.string().regex(IDENT, 'Loại chứng từ phải là chữ HOA và gạch dưới'),
    label: z.string().min(1).max(120),
    /** Đơn vị của ngưỡng — chỉ để hiển thị, nhưng bắt buộc để không ai hiểu nhầm. */
    unit: z.string().min(1, 'Phải ghi đơn vị (ngày / giờ / VND)').max(20),
    thresholds: z.array(approvalThresholdSchema).min(1, 'Phải có ít nhất một ngưỡng'),
  })
  .strict();

export type ApprovalRule = z.infer<typeof approvalRuleSchema>;

export const approvalParamsSchema = z
  .object({
    regimeCode: z.string().min(1).max(32),
    regimeLabel: z.string().min(1).max(200),
    levels: z.array(approvalLevelSchema).min(1, 'Phải có ít nhất một cấp duyệt'),
    rules: z.array(approvalRuleSchema).min(1, 'Phải có ít nhất một loại chứng từ'),
  })
  .superRefine((p, ctx) => {
    // --- 1. Cấp duyệt: mã và thứ bậc không trùng ---------------------------
    const levelCodes = new Set<string>();
    const seenOrder = new Set<number>();
    for (const l of p.levels) {
      if (levelCodes.has(l.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['levels'],
          message: `Mã cấp duyệt '${l.code}' bị trùng.`,
        });
      }
      levelCodes.add(l.code);
      if (seenOrder.has(l.order)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['levels'],
          message: `Thứ bậc ${l.order} bị trùng ('${l.code}'). Chuỗi duyệt sẽ không xác định được ai duyệt trước.`,
        });
      }
      seenOrder.add(l.order);
    }

    // --- 2. Loại chứng từ không trùng --------------------------------------
    const seenDoc = new Set<string>();
    for (const r of p.rules) {
      if (seenDoc.has(r.docType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message: `Loại chứng từ '${r.docType}' bị khai báo hai lần — không biết dùng bảng ngưỡng nào.`,
        });
      }
      seenDoc.add(r.docType);
    }

    // --- 3. Ngưỡng phải tăng dần và bậc cuối phải mở -----------------------
    // Đây là ràng buộc quan trọng nhất của cả file. Nếu ngưỡng không tăng dần
    // thì một giá trị có thể khớp nhiều bậc, và "cần những ai" trở nên mơ hồ.
    // Nếu bậc cuối không mở (upto khác null) thì một đơn đủ lớn sẽ KHÔNG khớp
    // bậc nào — tức là không cần ai duyệt. Cả hai đều là lỗi nghiêm trọng.
    for (const r of p.rules) {
      let prev = 0;
      let openEnded = false;
      for (let i = 0; i < r.thresholds.length; i++) {
        const t = r.thresholds[i];
        if (!t) continue;
        if (t.upto === null) {
          if (i !== r.thresholds.length - 1) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['rules'],
              message: `'${r.docType}': bậc không giới hạn phải là bậc CUỐI, đang ở vị trí ${i + 1}/${r.thresholds.length}.`,
            });
          }
          openEnded = true;
          continue;
        }
        if (t.upto <= prev) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rules'],
            message:
              `'${r.docType}': ngưỡng ${t.upto} phải LỚN HƠN ngưỡng trước (${prev}). ` +
              `Ngưỡng không tăng dần thì một giá trị khớp nhiều bậc.`,
          });
        }
        prev = t.upto;
      }
      if (!openEnded) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules'],
          message:
            `'${r.docType}': bậc cuối phải để trống ngưỡng (không giới hạn). ` +
            `Nếu không, một đơn vượt ${prev} ${r.unit} sẽ không khớp bậc nào và KHÔNG CẦN AI DUYỆT.`,
        });
      }
    }

    // --- 4. Ngưỡng phải trỏ tới cấp duyệt có thật --------------------------
    for (const r of p.rules) {
      for (const t of r.thresholds) {
        if (!levelCodes.has(t.level)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rules'],
            message: `'${r.docType}': cấp duyệt '${t.level}' không tồn tại. Các cấp đã có: ${[...levelCodes].join(', ')}.`,
          });
        }
      }
    }
  });

export type ApprovalParams = z.infer<typeof approvalParamsSchema>;

// ---------------------------------------------------------------------------
// JSON Schema — giao diện tự sinh form từ đây
// ---------------------------------------------------------------------------

export const approvalJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Ngưỡng duyệt',
  type: 'object',
  required: ['regimeCode', 'regimeLabel', 'levels', 'rules'],
  properties: {
    regimeCode: { type: 'string', title: 'Mã chế độ', maxLength: 32 },
    regimeLabel: { type: 'string', title: 'Tên chế độ', maxLength: 200 },
    levels: {
      type: 'array',
      title: 'Cấp duyệt',
      description: 'Thứ bậc nhỏ hơn = thấp hơn. Chuỗi duyệt đi từ thấp đến cao.',
      minItems: 1,
      items: {
        type: 'object',
        required: ['code', 'name', 'order'],
        properties: {
          code: { type: 'string', title: 'Mã cấp', maxLength: 32 },
          name: { type: 'string', title: 'Tên hiển thị', maxLength: 80 },
          order: { type: 'integer', title: 'Thứ bậc', minimum: 1 },
        },
      },
    },
    rules: {
      type: 'array',
      title: 'Ngưỡng theo loại chứng từ',
      minItems: 1,
      items: {
        type: 'object',
        required: ['docType', 'label', 'unit', 'thresholds'],
        properties: {
          docType: { type: 'string', title: 'Loại chứng từ', maxLength: 32 },
          label: { type: 'string', title: 'Tên hiển thị', maxLength: 120 },
          unit: { type: 'string', title: 'Đơn vị ngưỡng', maxLength: 20 },
          thresholds: {
            type: 'array',
            title: 'Bậc ngưỡng (phải tăng dần, bậc cuối để trống)',
            minItems: 1,
            items: {
              type: 'object',
              required: ['upto', 'level'],
              properties: {
                upto: {
                  type: ['number', 'null'],
                  title: 'Đến (không bao gồm)',
                  description: 'Để trống ở bậc cuối = không giới hạn',
                },
                level: { type: 'string', title: 'Mã cấp duyệt' },
              },
            },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// SEED — quy chế duyệt phổ biến ở doanh nghiệp VN
// ---------------------------------------------------------------------------

export const SEED_APPROVAL_VN_STD: ApprovalParams = {
  regimeCode: 'APPROVAL_VN_STD',
  regimeLabel: 'Quy chế duyệt chuẩn — nghỉ, công tác, chi phí, bảng lương',
  levels: [
    { code: 'DIRECT_MANAGER', name: 'Quản lý trực tiếp', order: 1 },
    { code: 'DEPT_HEAD', name: 'Trưởng phòng', order: 2 },
    { code: 'HR_HEAD', name: 'Giám đốc nhân sự', order: 3 },
    { code: 'CHIEF_ACCOUNTANT', name: 'Kế toán trưởng', order: 4 },
    { code: 'CEO', name: 'Tổng giám đốc', order: 5 },
  ],
  rules: [
    {
      docType: 'LEAVE',
      label: 'Đơn nghỉ phép',
      unit: 'ngày',
      thresholds: [
        { upto: 3, level: 'DIRECT_MANAGER' },
        { upto: 10, level: 'DEPT_HEAD' },
        { upto: null, level: 'HR_HEAD' },
      ],
    },
    {
      docType: 'BUSINESS_TRIP',
      label: 'Đơn công tác',
      unit: 'ngày',
      thresholds: [
        { upto: 5, level: 'DIRECT_MANAGER' },
        { upto: null, level: 'DEPT_HEAD' },
      ],
    },
    {
      docType: 'EXPENSE',
      label: 'Đề nghị thanh toán',
      unit: 'VND',
      thresholds: [
        { upto: 5_000_000, level: 'DIRECT_MANAGER' },
        { upto: 50_000_000, level: 'DEPT_HEAD' },
        { upto: 200_000_000, level: 'CHIEF_ACCOUNTANT' },
        { upto: null, level: 'CEO' },
      ],
    },
    {
      docType: 'PAYRUN',
      label: 'Bảng lương',
      unit: 'VND',
      thresholds: [
        { upto: null, level: 'CHIEF_ACCOUNTANT' },
      ],
    },
  ],
};
