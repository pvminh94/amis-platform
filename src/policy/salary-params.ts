/**
 * ============================================================================
 * CÔNG THỨC LƯƠNG — thành phần lương định nghĩa bằng BIỂU THỨC, không phải code
 * ============================================================================
 *
 * Đây là loại chính sách phức tạp nhất, vì tham số của nó không phải con số
 * mà là CÔNG THỨC. HR gõ vào:
 *
 *     round(baseSalary * kpiScore / 100)
 *     min(commissionRevenue * 0.03, commissionCap)
 *     lateCount > 10 ? round(lateCount * 50000) : 0
 *
 * Ba lớp bảo vệ:
 *
 *  1. BIỂU THỨC KHÔNG ĐƯỢC ĐÁNH GIÁ BẰNG eval. `src/engine/formula.ts` là một
 *     máy tính biểu thức đầy đủ (tokenizer → parser → AST → evaluator) port
 *     nguyên khối từ Phase 1 — nơi nó đã chạy thật và đã bắt được lỗi. Không
 *     có truy cập đối tượng, không gán, không vòng lặp, không global.
 *
 *  2. BIẾN PHẢI ĐƯỢC KHAI BÁO TƯỜNG MINH. Mỗi bộ công thức liệt kê
 *     `inputVariables`. Một thành phần chỉ được dùng biến trong danh sách đó
 *     hoặc mã của thành phần có `sequence` NHỎ HƠN. Điều này chặn cùng lúc ba
 *     lỗi: biến gõ sai, tham chiếu tới thành phần chưa tính, và tham chiếu
 *     vòng tròn.
 *
 *  3. ENGINE ÉP `onMissingVar: 'throw'`. Mặc định của evaluator là 'zero' —
 *     tiện cho calculator nhưng CHẾT NGƯỜI trong bảng lương: một biến gõ sai
 *     sẽ trả về 0 và nhân viên nhận lương thiếu mà không có dòng log nào.
 *
 * KHÔNG hardcode thành phần lương nào. Mọi thứ là dữ liệu.
 */

import { z } from 'zod';
import { validateFormula, extractVariables } from '../engine/formula.js';

/** Mã thành phần phải là định danh hợp lệ để dùng lại trong công thức khác. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const salaryComponentSchema = z
  .object({
    code: z
      .string()
      .min(1, 'Phải có mã thành phần')
      .max(32)
      .regex(IDENT, 'Mã thành phần chỉ gồm chữ, số, gạch dưới và không bắt đầu bằng số'),
    label: z.string().min(1, 'Phải có tên hiển thị').max(120),

    /** Biểu thức tính ra số tiền (VND). Được kiểm tra cú pháp ngay lúc lưu. */
    formula: z.string().min(1, 'Phải có công thức'),

    /**
     * Thứ tự tính. Thành phần có sequence nhỏ hơn được tính trước, và mã của
     * nó trở thành một biến cho các thành phần sau. Hai thành phần không được
     * cùng sequence — nếu không thứ tự sẽ phụ thuộc vào cách sắp xếp mảng,
     * tức là kết quả lương có thể đổi khi người dùng kéo thả lại bảng.
     *
     * Seed dùng BỘI SỐ 10 chứ không phải 1,2,3…: chèn một thành phần mới vào
     * giữa (vd. phụ cấp xăng ở 35) không phải đánh số lại toàn bộ, và không
     * phá các công thức đang tham chiếu theo thứ tự.
     */
    sequence: z.number().int('Thứ tự phải là số nguyên').min(1, 'Thứ tự bắt đầu từ 1'),

    /** Cộng vào thu nhập chịu thuế TNCN? (OT vượt 100%, ăn ca thì KHÔNG) */
    taxable: z.boolean(),

    /** Cộng vào căn cứ đóng BHXH/BHYT/BHTN? (thưởng, phụ cấp thường là KHÔNG) */
    inInsuranceBase: z.boolean(),

    /**
     * Cho phép ra số âm — dùng cho khoản khấu trừ (tạm ứng, bồi thường).
     * Nếu tắt mà công thức ra âm thì engine NÉM LỖI chứ không âm thầm lấy 0:
     * một khoản khấu trừ bị kẹp về 0 nghĩa là công ty mất tiền mà không ai biết.
     */
    allowNegative: z.boolean(),
  })
  .strict();

export type SalaryComponent = z.infer<typeof salaryComponentSchema>;

export const vnSalaryParamsSchema = z
  .object({
    regimeCode: z.string().min(1).max(32),
    regimeLabel: z.string().min(1).max(200),

    /**
     * Danh sách biến đầu vào hợp lệ. Khai báo tường minh để công thức không
     * tham chiếu tới thứ không tồn tại.
     */
    inputVariables: z
      .array(z.string().regex(IDENT, 'Tên biến không hợp lệ'))
      .min(1, 'Phải khai báo ít nhất một biến đầu vào'),

    components: z.array(salaryComponentSchema).min(1, 'Phải có ít nhất một thành phần'),
  })
  .superRefine((p, ctx) => {
    // --- 1. Mã thành phần và sequence không được trùng ---------------------
    const seenCode = new Set<string>();
    const seenSeq = new Set<number>();
    for (const c of p.components) {
      if (seenCode.has(c.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components'],
          message: `Mã thành phần '${c.code}' bị trùng.`,
        });
      }
      seenCode.add(c.code);

      if (seenSeq.has(c.sequence)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components'],
          message: `Thứ tự ${c.sequence} bị trùng (thành phần '${c.code}'). Hai thành phần cùng thứ tự thì kết quả phụ thuộc vào vị trí trong bảng.`,
        });
      }
      seenSeq.add(c.sequence);
    }

    // --- 2. Biến đầu vào không được trùng với mã thành phần -----------------
    // Nếu trùng, công thức sẽ không biết đang nói tới đầu vào hay kết quả.
    for (const v of p.inputVariables) {
      if (seenCode.has(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['inputVariables'],
          message: `'${v}' vừa là biến đầu vào vừa là mã thành phần.`,
        });
      }
    }

    // --- 3. Công thức phải parse được, và chỉ dùng biến đã biết -------------
    const inputs = new Set(p.inputVariables);
    for (const c of p.components) {
      const check = validateFormula(c.formula);
      if (!check.ok) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components'],
          message: `'${c.code}': công thức sai cú pháp — ${check.error}`,
        });
        continue;
      }

      // Biến được phép: đầu vào + các thành phần tính TRƯỚC (sequence nhỏ hơn)
      const allowed = new Set(inputs);
      for (const other of p.components) {
        if (other.sequence < c.sequence) allowed.add(other.code);
      }

      const unknown = check.variables.filter((v) => !allowed.has(v));
      if (unknown.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['components'],
          message:
            `'${c.code}' dùng biến chưa khai báo: ${unknown.join(', ')}. ` +
            `Chỉ được dùng biến đầu vào (${[...inputs].join(', ')}) ` +
            `hoặc mã thành phần có thứ tự nhỏ hơn ${c.sequence}.`,
        });
      }
    }
  });

export type VnSalaryParams = z.infer<typeof vnSalaryParamsSchema>;

// ---------------------------------------------------------------------------
// JSON Schema — giao diện tự sinh form từ đây
// ---------------------------------------------------------------------------
// `formula` để type 'string' với maxLength đủ lớn: đây là biểu thức, không phải
// đoạn văn. Form sẽ render textarea cho trường dài.

export const vnSalaryJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Công thức lương',
  type: 'object',
  required: ['regimeCode', 'regimeLabel', 'inputVariables', 'components'],
  properties: {
    regimeCode: { type: 'string', title: 'Mã chế độ', maxLength: 32 },
    regimeLabel: { type: 'string', title: 'Tên chế độ', maxLength: 200 },
    inputVariables: {
      type: 'array',
      title: 'Biến đầu vào cho phép',
      description:
        'Chỉ những biến này (và mã thành phần tính trước) được dùng trong công thức.',
      minItems: 1,
      items: { type: 'string', title: 'Tên biến' },
    },
    components: {
      type: 'array',
      title: 'Thành phần lương',
      minItems: 1,
      items: {
        type: 'object',
        required: [
          'code',
          'label',
          'formula',
          'sequence',
          'taxable',
          'inInsuranceBase',
          'allowNegative',
        ],
        properties: {
          code: {
            type: 'string',
            title: 'Mã (dùng lại trong công thức khác)',
            maxLength: 32,
            description: 'Chỉ chữ, số, gạch dưới. Ví dụ: LUONG_KPI',
          },
          label: { type: 'string', title: 'Tên hiển thị trên phiếu lương', maxLength: 120 },
          sequence: {
            type: 'integer',
            title: 'Thứ tự tính',
            minimum: 1,
            description: 'Tính từ nhỏ đến lớn. Thành phần trước thành biến cho thành phần sau.',
          },
          formula: {
            type: 'string',
            title: 'Công thức (VND)',
            maxLength: 500,
            description:
              'Ví dụ: round(baseSalary * kpiScore / 100). Hàm có sẵn: round, min, max, cap, tier, if…',
          },
          taxable: { type: 'boolean', title: 'Tính vào thu nhập chịu thuế TNCN' },
          inInsuranceBase: { type: 'boolean', title: 'Tính vào căn cứ đóng bảo hiểm' },
          allowNegative: { type: 'boolean', title: 'Cho phép ra số âm (khoản khấu trừ)' },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// SEED — một bảng lương có thật của doanh nghiệp VN
// ---------------------------------------------------------------------------

export const SEED_SALARY_VN_STD: VnSalaryParams = {
  regimeCode: 'SALARY_VN_STD',
  regimeLabel: 'Cơ cấu lương chuẩn — lương cơ bản, KPI, phụ cấp, OT, khấu trừ',
  inputVariables: [
    'baseSalary',
    'workedDays',
    'standardDays',
    'kpiScore',
    // OT BAN NGÀY — đã trừ phần đêm. Phần đêm nằm ở các biến otNight* bên dưới.
    'otNormalHours',
    'otWeekendHours',
    'otHolidayHours',
    // Giờ làm việc rơi vào khung 22:00–06:00 (phụ cấp 30%).
    'nightHours',
    // OT ban đêm, tách theo Điều 57 NĐ 145/2020 — bốn hệ số khác nhau.
    'otNightNormalWithDayOtHours',
    'otNightNormalNoDayOtHours',
    'otNightWeekendHours',
    'otNightHolidayHours',
    'hourlyRate',
    'mealDays',
    'lateCount',
    'advanceAmount',
  ],
  components: [
    {
      code: 'LUONG_CO_BAN',
      label: 'Lương cơ bản theo ngày công',
      sequence: 10,
      // Chia theo ngày công chuẩn, không chia cứng 26 — tháng 2 và tháng 7
      // khác nhau, và chia cứng sẽ làm lương tháng 2 cao bất thường.
      formula: 'round(baseSalary * workedDays / standardDays)',
      taxable: true,
      inInsuranceBase: true,
      allowNegative: false,
    },
    {
      code: 'LUONG_KPI',
      label: 'Lương theo kết quả công việc (KPI)',
      sequence: 20,
      // Tham chiếu LUONG_CO_BAN — thành phần có sequence nhỏ hơn.
      formula: 'round(LUONG_CO_BAN * kpiScore / 100)',
      taxable: true,
      // Thưởng KPI KHÔNG nằm trong căn cứ đóng bảo hiểm.
      inInsuranceBase: false,
      allowNegative: false,
    },
    {
      code: 'LUONG_OT',
      label: 'Lương làm thêm giờ ban ngày (150% / 200% / 300%)',
      sequence: 30,
      // Điều 98 khoản 1 BLLĐ 2019. Chỉ phần BAN NGÀY: giờ đêm nằm ở LUONG_OT_DEM.
      // Cộng cả hai vào một công thức thì giờ OT đêm bị trả hai lần, vì
      // ot_night_minutes là TẬP CON của ot_weekday/weekend/holiday_minutes.
      formula:
        'round(hourlyRate * (otNormalHours * 1.5 + otWeekendHours * 2 + otHolidayHours * 3))',
      taxable: true,
      inInsuranceBase: false,
      allowNegative: false,
    },
    {
      code: 'LUONG_OT_DEM',
      label: 'Lương làm thêm giờ ban đêm (200% / 210% / 270% / 390%)',
      sequence: 35,
      // Điều 57 NĐ 145/2020:
      //   [hệ số OT] + 30% (làm đêm) + 20% × [lương giờ ban ngày của ngày tương ứng]
      //
      // Khoản 20% đó nhân với lương giờ BAN NGÀY, và con số này là 100% hay 150%
      // tuỳ NGÀY ĐÓ ĐÃ CÓ OT BAN NGÀY hay chưa:
      //   ngày thường, chưa có OT ngày : 150 + 30 + 20×100 = 200%
      //   ngày thường, đã có OT ngày   : 150 + 30 + 20×150 = 210%
      //   ngày nghỉ hằng tuần          : 200 + 30 + 20×200 = 270%
      //   ngày lễ, tết                 : 300 + 30 + 20×300 = 390%
      // Gộp hai trường hợp ngày thường thành một hệ số là trả sai 10% trên toàn bộ
      // giờ OT đêm — và ca đêm là ca có nhiều OT đêm nhất.
      formula:
        'round(hourlyRate * (otNightNormalWithDayOtHours * 2.1 + otNightNormalNoDayOtHours * 2.0 ' +
        '+ otNightWeekendHours * 2.7 + otNightHolidayHours * 3.9))',
      taxable: true,
      inInsuranceBase: false,
      allowNegative: false,
    },
    {
      code: 'PHU_CAP_LAM_DEM',
      label: 'Phụ cấp làm đêm 30%',
      sequence: 38,
      // Điều 98 khoản 2 BLLĐ 2019: làm việc từ 22:00 đến 06:00 được trả THÊM ít
      // nhất 30% đơn giá giờ của ngày làm việc bình thường — cộng vào lương,
      // không phải thay thế.
      formula: 'round(hourlyRate * nightHours * 0.3)',
      taxable: true,
      inInsuranceBase: false,
      allowNegative: false,
    },
    {
      code: 'PHU_CAP_AN_CA',
      label: 'Phụ cấp ăn giữa ca',
      sequence: 40,
      // 730.000đ/tháng là mức miễn thuế; phần vượt phải chịu thuế. Việc tách
      // phần vượt do engine thuế làm, không phải ở đây — ở đây chỉ ghi nhận
      // toàn bộ và đánh dấu taxable để tầng thuế xử lý.
      formula: 'round(mealDays * 30000)',
      taxable: true,
      inInsuranceBase: false,
      allowNegative: false,
    },
    {
      code: 'PHAT_DI_MUON',
      label: 'Khấu trừ đi muộn',
      sequence: 50,
      // Quá 3 lần mới bắt đầu tính — ít hơn thì bỏ qua, tránh phạt vặt.
      formula: 'lateCount > 3 ? round((lateCount - 3) * 50000) * -1 : 0',
      taxable: false,
      inInsuranceBase: false,
      allowNegative: true,
    },
    {
      code: 'TAM_UNG',
      label: 'Trừ tạm ứng',
      sequence: 60,
      formula: 'advanceAmount * -1',
      taxable: false,
      inInsuranceBase: false,
      allowNegative: true,
    },
  ],
};
