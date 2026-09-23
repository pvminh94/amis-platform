/**
 * ============================================================================
 * MẪU IN — loại chính sách thứ năm
 * ============================================================================
 *
 * Đây là "print formatter chuyên sâu": mẫu phiếu lương, bảng chấm công, UNC…
 * là DỮ LIỆU trong database. Kế toán sửa tiêu đề, thêm dòng, đổi công thức
 * một cột ngay trên giao diện — không cần developer, không cần deploy.
 *
 * VÌ SAO KHÔNG DÙNG PUPPETEER/CHROMIUM:
 *   Chromium ~170MB tải về và ~300MB RAM khi chạy, trong sandbox 2GB đang
 *   chạy chung PostgreSQL và dev server. Đổi lại ta được gì? Một file PDF.
 *   Trong khi trình duyệt đã có sẵn "In → Lưu thành PDF" với chất lượng排版
 *   tốt hơn bất kỳ thư viện nào. ERPNext cũng làm đúng như vậy: Print Format
 *   render HTML, trình duyệt lo phần PDF.
 *
 *   Cái khó và đáng giá nằm ở TẦNG TEMPLATE — ràng buộc dữ liệu, định dạng
 *   tiền/ngày, vòng lặp bảng, và QUAN TRỌNG NHẤT là chống XSS. Đó là thứ
 *   file này và engine/print.ts làm.
 *
 * MÔ HÌNH AN TOÀN:
 *   - MẪU (body, css) do quản trị soạn → ĐÁNG TIN, được chèn nguyên văn
 *   - DỮ LIỆU (tên nhân viên, ghi chú, lý do nghỉ…) → KHÔNG đáng tin, LUÔN
 *     escape. Một ô "lý do nghỉ" chứa <script> mà không escape là stored XSS
 *     chạy trên máy kế toán trưởng mỗi lần in phiếu lương.
 */

import { z } from 'zod';
import { validateFormula } from '../engine/formula.js';

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Định dạng hiển thị của một trường. */
export const PRINT_FORMATS = ['text', 'money', 'number', 'percent', 'date', 'upper'] as const;
export type PrintFormat = (typeof PRINT_FORMATS)[number];

export const printFieldSchema = z
  .object({
    /** Mã trường, dùng trong mẫu: {{ THUC_NHAN }} */
    code: z
      .string()
      .regex(IDENT, 'Mã trường chỉ gồm chữ, số, gạch dưới và không bắt đầu bằng số'),
    label: z.string().min(1, 'Phải có nhãn').max(80),
    /**
     * Biểu thức tính bằng formula engine (chỉ số học). Bỏ trống nếu trường
     * lấy thẳng từ dữ liệu.
     */
    /**
     * Biểu thức tính. Chuỗi RỖNG nghĩa là lấy thẳng từ dữ liệu.
     *
     * KHÔNG dùng .default(''): schema có .default() thì kiểu input khác kiểu
     * output, mà `z.ZodType<T>` khai báo T cho CẢ HAI — nên mọi chỗ gọi
     * resolvePolicy sẽ vỡ kiểu. Đây là lần THỨ HAI bug này xuất hiện (lần
     * trước là exemptMealCapMonthly ở VN_PIT). Kết luận đã thành nguyên tắc:
     * tham số cấu hình không có giá trị ngầm định, người dùng phải điền có ý thức.
     */
    expr: z.string().max(500),
    format: z.enum(PRINT_FORMATS),
    /** Số chữ số thập phân, chỉ dùng cho number/percent. */
    decimals: z.number().int().min(0).max(6),
  })
  .strict();

export type PrintField = z.infer<typeof printFieldSchema>;

export const printParamsSchema = z
  .object({
    regimeCode: z.string().min(1).max(32),
    regimeLabel: z.string().min(1).max(200),

    paperSize: z.enum(['A4', 'A5', 'LETTER']),
    orientation: z.enum(['portrait', 'landscape']),
    marginMm: z
      .object({
        top: z.number().min(0).max(60),
        right: z.number().min(0).max(60),
        bottom: z.number().min(0).max(60),
        left: z.number().min(0).max(60),
      })
      .strict(),

    /**
     * Các BIẾN SỐ HỌC đầu vào mà biểu thức được phép dùng. Khai báo tường
     * minh để một công thức không tham chiếu tới thứ không tồn tại — cùng
     * nguyên tắc với công thức lương.
     */
    numericInputs: z.array(z.string().regex(IDENT, 'Tên biến không hợp lệ')),

    fields: z.array(printFieldSchema),

    /** CSS in ấn. Được chèn NGUYÊN VĂN vào <style> — do quản trị soạn. */
    css: z.string().max(20_000),

    /**
     * Thân mẫu HTML. Cú pháp:
     *   {{ field }}              → escape HTML, định dạng theo `format`
     *   {{ field | raw }}        → KHÔNG escape (chỉ dùng khi chắc chắn an toàn)
     *   {{#each rows}} … {{/each}}
     *   {{#if cond}} … {{else}} … {{/if}}
     *   {{! chú thích }}
     */
    body: z.string().min(1, 'Mẫu không được rỗng').max(100_000),
  })
  .superRefine((p, ctx) => {
    // --- 1. Mã trường không trùng ------------------------------------------
    const codes = new Set<string>();
    for (const f of p.fields) {
      if (codes.has(f.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields'],
          message: `Mã trường '${f.code}' bị trùng.`,
        });
      }
      codes.add(f.code);
    }

    // --- 2. Biểu thức phải parse được và chỉ dùng biến đã khai báo ---------
    const allowed = new Set(p.numericInputs);
    for (const f of p.fields) {
      if (!f.expr || f.expr.trim() === '') continue;
      const check = validateFormula(f.expr);
      if (!check.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields'],
          message: `Trường '${f.code}': biểu thức sai cú pháp — ${check.error}`,
        });
        continue;
      }
      const unknown = check.variables.filter((v) => !allowed.has(v));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['fields'],
          message:
            `Trường '${f.code}' dùng biến chưa khai báo: ${unknown.join(', ')}. ` +
            `Các biến số học đã khai báo: ${[...allowed].join(', ') || '(không có)'}.`,
        });
      }
    }

    // --- 3. Mẫu không được chứa thẻ script --------------------------------
    // Mẫu là do quản trị soạn nên về nguyên tắc đáng tin, nhưng chặn <script>
    // vẫn rẻ hơn nhiều so với một lỗ hổng XSS trên trang in của kế toán.
    // <style> thì cho phép vì đó là cách duy nhất để định dạng bản in.
    if (/<script[\s>]/i.test(p.body) || /on\w+\s*=\s*["']/i.test(p.body)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['body'],
        message: 'Mẫu in không được chứa <script> hoặc thuộc tính sự kiện (onclick=…).',
      });
    }
    if (/<script[\s>]/i.test(p.css)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['css'],
        message: 'CSS không được chứa <script>.',
      });
    }
  });

export type PrintParams = z.infer<typeof printParamsSchema>;

// ---------------------------------------------------------------------------
// JSON Schema — giao diện tự sinh form từ đây
// ---------------------------------------------------------------------------

const mm = (title: string) => ({ type: 'number', title, minimum: 0, maximum: 60 });

export const printJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Mẫu in',
  type: 'object',
  required: [
    'regimeCode',
    'regimeLabel',
    'paperSize',
    'orientation',
    'marginMm',
    'numericInputs',
    'fields',
    'css',
    'body',
  ],
  properties: {
    regimeCode: { type: 'string', title: 'Mã mẫu', maxLength: 32 },
    regimeLabel: { type: 'string', title: 'Tên mẫu', maxLength: 200 },
    paperSize: { type: 'string', title: 'Khổ giấy', enum: ['A4', 'A5', 'LETTER'] },
    orientation: { type: 'string', title: 'Hướng giấy', enum: ['portrait', 'landscape'] },
    marginMm: {
      type: 'object',
      title: 'Lề (mm)',
      required: ['top', 'right', 'bottom', 'left'],
      properties: {
        top: mm('Trên'),
        right: mm('Phải'),
        bottom: mm('Dưới'),
        left: mm('Trái'),
      },
    },
    numericInputs: {
      type: 'array',
      title: 'Biến số học cho phép dùng trong biểu thức',
      items: { type: 'string', title: 'Tên biến' },
    },
    fields: {
      type: 'array',
      title: 'Trường dữ liệu',
      items: {
        type: 'object',
        required: ['code', 'label', 'expr', 'format', 'decimals'],
        properties: {
          code: { type: 'string', title: 'Mã (dùng trong mẫu)', maxLength: 32 },
          label: { type: 'string', title: 'Nhãn', maxLength: 80 },
          expr: {
            type: 'string',
            title: 'Biểu thức (để trống = lấy thẳng từ dữ liệu)',
            maxLength: 500,
          },
          format: {
            type: 'string',
            title: 'Định dạng',
            enum: ['text', 'money', 'number', 'percent', 'date', 'upper'],
          },
          decimals: { type: 'integer', title: 'Số thập phân', minimum: 0, maximum: 6 },
        },
      },
    },
    css: {
      type: 'string',
      title: 'CSS in ấn',
      description: 'Được chèn nguyên văn vào <style>. Có thể dùng @page, @media print.',
    },
    body: {
      type: 'string',
      title: 'Thân mẫu (HTML)',
      description:
        '{{ truong }} để chèn dữ liệu (tự escape). {{#each dong}}…{{/each}} để lặp bảng.',
    },
  },
} as const;

// ---------------------------------------------------------------------------
// SEED — PHIẾU LƯƠNG, mẫu in được dùng nhiều nhất
// ---------------------------------------------------------------------------

export const SEED_PRINT_PAYSLIP: PrintParams = {
  regimeCode: 'PHIEU_LUONG',
  regimeLabel: 'Phiếu lương',
  paperSize: 'A4',
  orientation: 'portrait',
  marginMm: { top: 15, right: 15, bottom: 15, left: 15 },
  numericInputs: [
    'gross',
    'siEmployee',
    'pit',
    'advance',
    'dependents',
    'workedDays',
    'standardDays',
  ],
  fields: [
    { code: 'GROSS', label: 'Tổng thu nhập', expr: 'gross', format: 'money', decimals: 0 },
    { code: 'SI', label: 'Bảo hiểm NLĐ', expr: 'siEmployee', format: 'money', decimals: 0 },
    { code: 'THUE', label: 'Thuế TNCN', expr: 'pit', format: 'money', decimals: 0 },
    { code: 'TAM_UNG', label: 'Tạm ứng', expr: 'advance', format: 'money', decimals: 0 },
    {
      code: 'THUC_NHAN',
      label: 'Thực nhận',
      expr: 'gross - siEmployee - pit - advance',
      format: 'money',
      decimals: 0,
    },
    {
      code: 'TY_LE_THUE',
      label: 'Tỷ lệ thuế trên tổng thu nhập',
      expr: 'pit / gross * 100',
      format: 'percent',
      decimals: 2,
    },
    {
      code: 'NGAY_CONG',
      label: 'Ngày công',
      expr: 'workedDays',
      format: 'number',
      decimals: 1,
    },
    { code: 'TEN_NV', label: 'Họ tên', expr: '', format: 'upper', decimals: 0 },
    { code: 'KY_LUONG', label: 'Kỳ lương', expr: '', format: 'text', decimals: 0 },
    { code: 'BO_PHAN', label: 'Bộ phận', expr: '', format: 'text', decimals: 0 },
    { code: 'NGAY_IN', label: 'Ngày in', expr: '', format: 'date', decimals: 0 },
  ],
  css: `
    body { font-family: 'DejaVu Sans', Arial, sans-serif; font-size: 11pt; color: #111; }
    h1 { font-size: 15pt; text-transform: uppercase; letter-spacing: 1px; margin: 0 0 4px; }
    .sub { color: #555; font-size: 9.5pt; margin-bottom: 14px; }
    .head { display: flex; justify-content: space-between; align-items: flex-start;
            border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 14px; }
    table { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
    th, td { padding: 5px 7px; border-bottom: 1px solid #ddd; text-align: left; }
    th { background: #f2f2f2; font-weight: 600; font-size: 9.5pt;
         text-transform: uppercase; letter-spacing: .5px; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    tr.total td { border-top: 2px solid #111; border-bottom: none; font-weight: 700; }
    .net { font-size: 13pt; background: #f7f7f7; }
    .sign { display: flex; justify-content: space-between; margin-top: 28px;
            text-align: center; font-size: 10pt; }
    .sign div { width: 30%; }
    .sign .line { border-top: 1px solid #999; margin-top: 46px; padding-top: 4px; }
    .note { font-size: 8.5pt; color: #666; margin-top: 16px; }
    .no-print { background: #fffbe6; border: 1px solid #e6d88a; padding: 8px 12px;
                margin-bottom: 14px; font-size: 10pt; }

    /* KHÔNG khai báo @page ở đây. renderDocument đã sinh @page theo paperSize,
       orientation và marginMm của bộ tham số; khai báo lại trong CSS mẫu sẽ
       tham gia cascade và có thể ghi đè lề đã cấu hình — một cái bẫy rất khó
       nhìn ra vì bản in vẫn đẹp trên màn hình, chỉ sai khi in thật. */
    @media print {
      .no-print { display: none; }
      body { font-size: 10.5pt; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; }
      thead { display: table-header-group; }  /* lặp tiêu đề bảng ở mỗi trang */
      .sign { page-break-inside: avoid; }
    }
  `,
  body: `
<div class="no-print">
  Đây là bản xem trước. Dùng <strong>In → Lưu thành PDF</strong> của trình duyệt
  (Ctrl/Cmd + P) để xuất file. Khung vàng này sẽ không xuất hiện trên bản in.
</div>

<div class="head">
  <div>
    <h1>Phiếu lương</h1>
    <div class="sub">Kỳ {{ KY_LUONG }} · Bộ phận: {{ BO_PHAN }}</div>
  </div>
  <div style="text-align:right">
    <div class="sub">Ngày in: {{ NGAY_IN }}</div>
  </div>
</div>

<table>
  <tr><th style="width:35%">Họ và tên</th><td>{{ TEN_NV }}</td></tr>
  <tr><th>Ngày công</th><td class="num">{{ NGAY_CONG }} / {{ standardDays }}</td></tr>
  <tr><th>Người phụ thuộc</th><td class="num">{{ dependents }}</td></tr>
</table>

<table>
  <thead>
    <tr><th>Chỉ tiêu</th><th class="num">Số tiền</th><th class="num" style="width:18%">Ghi chú</th></tr>
  </thead>
  <tbody>
    <tr><td>Tổng thu nhập</td><td class="num">{{ GROSS }}</td><td class="num"></td></tr>
    <tr><td>Trừ bảo hiểm (NLĐ)</td><td class="num">({{ SI }})</td><td class="num"></td></tr>
    <tr><td>Trừ thuế TNCN</td><td class="num">({{ THUE }})</td><td class="num">{{ TY_LE_THUE }}</td></tr>
    <tr><td>Trừ tạm ứng</td><td class="num">({{ TAM_UNG }})</td><td class="num"></td></tr>
    <tr class="total net"><td>THỰC NHẬN</td><td class="num">{{ THUC_NHAN }}</td><td class="num"></td></tr>
  </tbody>
</table>

<div class="note">
  Số tiền bằng chữ: {{ THUC_NHAN | words }}<br>
  Phiếu này được sinh tự động từ hệ thống. Mọi thắc mắc liên hệ phòng Nhân sự.
</div>

<div class="sign">
  <div>Người nhận<div class="line"></div></div>
  <div>Kế toán<div class="line"></div></div>
  <div>Giám đốc<div class="line"></div></div>
</div>
`,
};
