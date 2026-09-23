/**
 * ============================================================================
 * THAM SỐ BẢO HIỂM XÃ HỘI VIỆT NAM — loại chính sách THỨ HAI
 * ============================================================================
 *
 * File này tồn tại để CHỨNG MINH một lời hứa: thêm một loại chính sách mới
 * thì KHÔNG phải viết form mới. Toàn bộ giao diện chỉnh sửa của VN_BHXH được
 * sinh ra từ vnSiJsonSchema bên dưới. Thứ duy nhất phải sửa trong tầng API là
 * MỘT DÒNG trong map VALIDATORS.
 *
 * Căn cứ pháp lý:
 *   - Luật BHXH 2024, Điều 31 điểm đ khoản 1: trần đóng BHXH/BHYT = 20 × mức
 *     tham chiếu (trước đây gọi là lương cơ sở)
 *   - NĐ 161/2026: mức tham chiếu 2.530.000đ từ 01/07/2026 (trước đó 2.340.000đ)
 *   - NĐ 293/2025: lương tối thiểu vùng I/II/III/IV = 5.310.000 / 4.730.000 /
 *     4.140.000 / 3.700.000
 *   - BHTN: trần = 20 × lương tối thiểu vùng; sàn = lương tối thiểu vùng,
 *     cộng 7% nếu đã qua đào tạo nghề
 *   - Tỷ lệ: NLĐ 10,5% (BHXH 8% + BHYT 1,5% + BHTN 1%);
 *            NSDLĐ 21,5% (17% + 3% + 1%) và 0,5% quỹ TNLĐ-BNN (3388)
 *
 * KHÔNG hardcode bất kỳ con số nào ở trên vào engine — tất cả là dữ liệu.
 */

import { z } from 'zod';

const vnd = z.number().int('Phải là số nguyên (VND)');
const nonNegativeVnd = vnd.nonnegative('Không được âm');

const rate = z
  .number()
  .min(0, 'Tỷ lệ không được âm')
  .max(1, 'Tỷ lệ không được vượt 100%');

/**
 * Lương tối thiểu theo vùng. `region` là nhãn vùng La Mã — giữ dạng chuỗi vì
 * đây là tên pháp lý ("Vùng I"), không phải thứ tự để tính toán.
 */
export const regionalMinimumWageSchema = z
  .object({
    region: z.enum(['I', 'II', 'III', 'IV'], {
      errorMap: () => ({ message: 'Vùng phải là I, II, III hoặc IV' }),
    }),
    monthly: nonNegativeVnd.describe('Lương tối thiểu tháng của vùng (VND)'),
  })
  .strict();

export type RegionalMinimumWage = z.infer<typeof regionalMinimumWageSchema>;

export const vnSiParamsSchema = z
  .object({
    regimeCode: z.string().min(1, 'Phải có mã chế độ').max(32),
    regimeLabel: z.string().min(1, 'Phải có tên chế độ').max(200),

    referenceSalary: nonNegativeVnd.describe(
      'Mức tham chiếu / lương cơ sở (VND/tháng) — gốc của trần và sàn BHXH, BHYT',
    ),

    /**
     * Hệ số trần BHXH/BHYT = 20 × mức tham chiếu.
     * Tách thành hệ số thay vì lưu sẵn con số 50.600.000: khi mức tham chiếu
     * đổi (NĐ mới), người dùng chỉ sửa MỘT ô và trần tự đúng. Lưu sẵn con số
     * là nguyên nhân kinh điển của việc "đổi luật mà quên đổi trần".
     */
    siCapMultiplier: z
      .number()
      .min(1, 'Hệ số trần phải ≥ 1')
      .describe('Trần đóng BHXH/BHYT = hệ số × mức tham chiếu (hiện hành: 20)'),

    employee: z
      .object({
        socialInsurance: rate.describe('BHXH phần NLĐ (hiện hành 8%)'),
        healthInsurance: rate.describe('BHYT phần NLĐ (hiện hành 1,5%)'),
        unemployment: rate.describe('BHTN phần NLĐ (hiện hành 1%)'),
      })
      .strict(),

    employer: z
      .object({
        socialInsurance: rate.describe('BHXH phần NSDLĐ (hiện hành 17%)'),
        healthInsurance: rate.describe('BHYT phần NSDLĐ (hiện hành 3%)'),
        unemployment: rate.describe('BHTN phần NSDLĐ (hiện hành 1%)'),
        accident: rate.describe('Quỹ TNLĐ-BNN, hạch toán 3388 (hiện hành 0,5%)'),
      })
      .strict(),

    /** Trần BHTN = hệ số × lương tối thiểu vùng (hiện hành 20). */
    uiCapMultiplier: z.number().min(1, 'Hệ số trần BHTN phải ≥ 1'),

    /**
     * Cộng thêm 7% vào sàn BHTN cho lao động đã qua đào tạo nghề.
     * Đây là chỗ HAY SAI NHẤT: nhiều hệ thống cộng 7% vào lương tối thiểu rồi
     * dùng làm TRẦN, hoặc quên hẳn. Nó là SÀN, và chỉ áp cho BHTN.
     */
    trainedWorkerUplift: rate.describe(
      'Cộng thêm vào SÀN BHTN cho lao động đã qua đào tạo nghề (hiện hành 7%)',
    ),

    regionalMinimumWages: z
      .array(regionalMinimumWageSchema)
      .min(1, 'Phải khai báo ít nhất một vùng'),
  })
  .superRefine((p, ctx) => {
    // --- 1. Hệ số trần phải > 1, nếu không trần ≤ sàn: vô nghĩa -----------
    // Hệ số = 1 nghĩa là trần đóng BHXH đúng bằng mức tham chiếu, tức mọi
    // người đều đóng trên cùng một mức. Không có chế độ nào như vậy, và nếu
    // ai đó gõ nhầm 1 thì toàn bộ lương trên mức tham chiếu sẽ không bị trích
    // bảo hiểm — thất thoát lớn mà không lỗi nào hiện ra.
    for (const [field, label] of [
      ['siCapMultiplier', 'BHXH/BHYT'],
      ['uiCapMultiplier', 'BHTN'],
    ] as const) {
      if (p[field] <= 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `Hệ số trần ${label} phải LỚN HƠN 1 (hiện hành là 20). Hệ số = 1 nghĩa là trần đóng bằng sàn, toàn bộ phần lương vượt mức tham chiếu sẽ không bị trích bảo hiểm.`,
        });
      }
    }

    // --- 2. Mỗi quỹ: phần NSDLĐ không được nhỏ hơn phần NLĐ ---------------
    // Với cả ba quỹ BHXH/BHYT/BHTN, luật luôn quy định phần doanh nghiệp chịu
    // lớn hơn phần người lao động. Nếu ngược lại thì gần chắc chắn là nhập
    // nhầm hai cột cho nhau (vd. gõ 17% vào cột NLĐ và 8% vào cột NSDLĐ).
    for (const fund of ['socialInsurance', 'healthInsurance', 'unemployment'] as const) {
      const emp = p.employee[fund];
      const emplr = p.employer[fund];
      if (emplr < emp) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['employer', fund],
          message: `Phần NSDLĐ (${(emplr * 100).toFixed(2)}%) đang NHỎ HƠN phần NLĐ (${(emp * 100).toFixed(2)}%). Với quỹ này luật luôn quy định ngược lại — kiểm tra xem có nhập nhầm hai cột không.`,
        });
      }
    }

    // --- 3. Vùng không được trùng, và lương tối thiểu phải giảm dần I→IV ----
    // Vùng I là đô thị lớn nhất nên lương tối thiểu cao nhất. Nếu Vùng III lớn
    // hơn Vùng I thì đó là gõ nhầm, và sẽ làm trần BHTN của cả hai vùng sai.
    const seen = new Set<string>();
    for (const r of p.regionalMinimumWages) {
      if (seen.has(r.region)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regionalMinimumWages'],
          message: `Vùng ${r.region} bị khai báo hai lần.`,
        });
      }
      seen.add(r.region);
    }
    const order = ['I', 'II', 'III', 'IV'];
    const sorted = [...p.regionalMinimumWages].sort(
      (a, b) => order.indexOf(a.region) - order.indexOf(b.region),
    );
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      // tsconfig bật noUncheckedIndexedAccess: phải guard dù i < length luôn đúng
      if (!prev || !cur) continue;
      if (cur.monthly >= prev.monthly) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['regionalMinimumWages'],
          message: `Lương tối thiểu Vùng ${cur.region} (${cur.monthly.toLocaleString('vi-VN')}đ) phải THẤP HƠN Vùng ${prev.region} (${prev.monthly.toLocaleString('vi-VN')}đ).`,
        });
      }
    }
  });

export type VnSiParams = z.infer<typeof vnSiParamsSchema>;

// ---------------------------------------------------------------------------
// JSON Schema — MỘT BẢN MÔ TẢ DUY NHẤT mà giao diện dùng để TỰ SINH form
// ---------------------------------------------------------------------------
// Phải khớp tuyệt đối với Zod schema ở trên: tests/si-params.spec.ts so sánh
// hai bên từng trường. Bài học từ VN_PIT — lệch nhau một trường là form cho
// lưu thiếu tham số pháp lý mà không ai biết.

const money = (title: string, description?: string) => ({
  type: 'integer',
  title,
  minimum: 0,
  ...(description ? { description } : {}),
});

const pct = (title: string, description?: string) => ({
  type: 'number',
  title,
  minimum: 0,
  maximum: 1,
  ...(description ? { description } : {}),
});

export const vnSiJsonSchema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Tham số bảo hiểm xã hội Việt Nam',
  type: 'object',
  required: [
    'regimeCode',
    'regimeLabel',
    'referenceSalary',
    'siCapMultiplier',
    'employee',
    'employer',
    'uiCapMultiplier',
    'trainedWorkerUplift',
    'regionalMinimumWages',
  ],
  properties: {
    regimeCode: { type: 'string', title: 'Mã chế độ', maxLength: 32 },
    regimeLabel: { type: 'string', title: 'Tên chế độ', maxLength: 200 },
    referenceSalary: money(
      'Mức tham chiếu / lương cơ sở (VND/tháng)',
      'Gốc của trần và sàn BHXH, BHYT',
    ),
    siCapMultiplier: {
      type: 'number',
      title: 'Hệ số trần BHXH/BHYT',
      minimum: 1,
      description: 'Trần = hệ số × mức tham chiếu. Hiện hành 20.',
    },
    employee: {
      type: 'object',
      title: 'Tỷ lệ người lao động đóng',
      required: ['socialInsurance', 'healthInsurance', 'unemployment'],
      properties: {
        socialInsurance: pct('BHXH (8%)'),
        healthInsurance: pct('BHYT (1,5%)'),
        unemployment: pct('BHTN (1%)'),
      },
    },
    employer: {
      type: 'object',
      title: 'Tỷ lệ doanh nghiệp đóng',
      required: ['socialInsurance', 'healthInsurance', 'unemployment', 'accident'],
      properties: {
        socialInsurance: pct('BHXH (17%)'),
        healthInsurance: pct('BHYT (3%)'),
        unemployment: pct('BHTN (1%)'),
        accident: pct('Quỹ TNLĐ-BNN — TK 3388 (0,5%)'),
      },
    },
    uiCapMultiplier: {
      type: 'number',
      title: 'Hệ số trần BHTN',
      minimum: 1,
      description: 'Trần BHTN = hệ số × lương tối thiểu vùng. Hiện hành 20.',
    },
    trainedWorkerUplift: pct(
      'Cộng thêm vào SÀN BHTN nếu đã qua đào tạo nghề (7%)',
      'Chỉ áp cho BHTN, và chỉ cho SÀN — không phải trần.',
    ),
    regionalMinimumWages: {
      type: 'array',
      title: 'Lương tối thiểu theo vùng',
      minItems: 1,
      items: {
        type: 'object',
        required: ['region', 'monthly'],
        properties: {
          region: { type: 'string', title: 'Vùng', enum: ['I', 'II', 'III', 'IV'] },
          monthly: money('Lương tối thiểu tháng (VND)'),
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// DỮ LIỆU SEED — hai mốc có thật của mức tham chiếu
// ---------------------------------------------------------------------------

const REGIONS_2026: RegionalMinimumWage[] = [
  { region: 'I', monthly: 5_310_000 },
  { region: 'II', monthly: 4_730_000 },
  { region: 'III', monthly: 4_140_000 },
  { region: 'IV', monthly: 3_700_000 },
];

const RATES = {
  employee: { socialInsurance: 0.08, healthInsurance: 0.015, unemployment: 0.01 },
  employer: {
    socialInsurance: 0.17,
    healthInsurance: 0.03,
    unemployment: 0.01,
    accident: 0.005,
  },
};

/** Đến 30/06/2026: mức tham chiếu 2.340.000đ. */
export const SEED_SI_TO_2026_06: VnSiParams = {
  regimeCode: 'SI_TO_2026_06',
  regimeLabel: 'Mức tham chiếu 2.340.000đ — đến 30/06/2026',
  referenceSalary: 2_340_000,
  siCapMultiplier: 20,
  uiCapMultiplier: 20,
  trainedWorkerUplift: 0.07,
  ...RATES,
  regionalMinimumWages: REGIONS_2026,
};

/** Từ 01/07/2026: mức tham chiếu 2.530.000đ (NĐ 161/2026). */
export const SEED_SI_FROM_2026_07: VnSiParams = {
  regimeCode: 'SI_FROM_2026_07',
  regimeLabel: 'Mức tham chiếu 2.530.000đ (NĐ 161/2026) — từ 01/07/2026',
  referenceSalary: 2_530_000,
  siCapMultiplier: 20,
  uiCapMultiplier: 20,
  trainedWorkerUplift: 0.07,
  ...RATES,
  regionalMinimumWages: REGIONS_2026,
};
