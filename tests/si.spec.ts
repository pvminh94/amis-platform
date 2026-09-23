/**
 * ============================================================================
 * TEST — LOẠI CHÍNH SÁCH VN_BHXH (engine + schema + ràng buộc pháp lý)
 * ============================================================================
 *
 * Các con số kỳ vọng trong file này được TÍNH TAY từ tỷ lệ luật định, không
 * lấy từ output của engine. Nếu engine sai thì test đỏ — đó là điểm của test.
 */
import { describe, it, expect } from 'vitest';
import {
  vnSiParamsSchema,
  vnSiJsonSchema,
  SEED_SI_TO_2026_06,
  SEED_SI_FROM_2026_07,
  type VnSiParams,
} from '../src/policy/si-params.js';
import { calculateSocialInsurance, regionalMinimumWage } from '../src/engine/si.js';
import {
  defaultsFromSchema,
  validateAgainstSchema,
  type JsonSchema,
} from '../src/components/schema-form.js';
import { expectSchemasAgree } from './helpers.js';

const SCHEMA = vnSiJsonSchema as unknown as JsonSchema;
const BEFORE = SEED_SI_TO_2026_06; // tham chiếu 2.340.000đ
const AFTER = SEED_SI_FROM_2026_07; // tham chiếu 2.530.000đ

// ---------------------------------------------------------------------------
// 1. HAI SCHEMA PHẢI KHỚP NHAU
// ---------------------------------------------------------------------------

describe('VN_BHXH: JSON Schema và Zod schema khớp nhau', () => {
  it('cùng tập tên trường và cùng danh sách bắt buộc', () => {
    const { jsonFields } = expectSchemasAgree(vnSiJsonSchema, vnSiParamsSchema);
    expect(jsonFields).toContain('referenceSalary');
    expect(jsonFields).toContain('regionalMinimumWages');
  });

  it('bộ seed parse được bằng chính Zod schema', () => {
    expect(vnSiParamsSchema.safeParse(BEFORE).success).toBe(true);
    expect(vnSiParamsSchema.safeParse(AFTER).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. RÀNG BUỘC NGHIỆP VỤ (superRefine)
// ---------------------------------------------------------------------------

describe('VN_BHXH: ràng buộc nghiệp vụ chặn lúc LƯU, không phải lúc tính lương', () => {
  it('hệ số trần = 1 bị chặn (trần bằng sàn thì phần lương vượt sẽ không bị trích)', () => {
    const bad = { ...BEFORE, siCapMultiplier: 1 };
    const r = vnSiParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path.join('.')) ?? [];
    expect(paths).toContain('siCapMultiplier');
  });

  it('phần NSDLĐ nhỏ hơn phần NLĐ bị chặn — dấu hiệu nhập nhầm hai cột', () => {
    const bad: VnSiParams = {
      ...BEFORE,
      employee: { ...BEFORE.employee, socialInsurance: 0.17 },
      employer: { ...BEFORE.employer, socialInsurance: 0.08 },
    };
    const r = vnSiParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path.join('.'))).toContain(
      'employer.socialInsurance',
    );
  });

  it('lương tối thiểu Vùng III cao hơn Vùng I bị chặn', () => {
    const bad: VnSiParams = {
      ...BEFORE,
      regionalMinimumWages: BEFORE.regionalMinimumWages.map((r) =>
        r.region === 'III' ? { ...r, monthly: 9_000_000 } : r,
      ),
    };
    const r = vnSiParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/phải THẤP HƠN/);
  });

  it('khai báo trùng vùng bị chặn', () => {
    const bad: VnSiParams = {
      ...BEFORE,
      regionalMinimumWages: [
        ...BEFORE.regionalMinimumWages,
        { region: 'I', monthly: 5_000_000 },
      ],
    };
    const r = vnSiParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/hai lần/);
  });

  it('vùng không hợp lệ (V) bị chặn ngay từ kiểu dữ liệu', () => {
    const bad = {
      ...BEFORE,
      regionalMinimumWages: [{ region: 'V', monthly: 3_000_000 }],
    };
    expect(vnSiParamsSchema.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. ENGINE — SỐ LIỆU TÍNH TAY
// ---------------------------------------------------------------------------

describe('Engine BHXH: trần theo mức tham chiếu, trần BHTN theo vùng', () => {
  it('lương 60tr vượt trần BHXH → kẹp ở 20× tham chiếu, nhưng BHTN KHÔNG bị kẹp', () => {
    const r = calculateSocialInsurance(
      { contributionSalary: 60_000_000, wageRegion: 'I', trainedWorker: true },
      BEFORE,
    );
    // Trần BHXH/BHYT = 20 × 2.340.000 = 46.800.000
    expect(r.siCap).toBe(46_800_000);
    expect(r.siBase).toBe(46_800_000);
    expect(r.siHitCap).toBe(true);
    // Trần BHTN = 20 × 5.310.000 (vùng I) = 106.200.000 → 60tr chưa chạm
    expect(r.uiCap).toBe(106_200_000);
    expect(r.uiBase).toBe(60_000_000);
    expect(r.uiHitCap).toBe(false);

    // NLĐ: 8% và 1,5% trên 46,8tr; 1% BHTN trên 60tr
    expect(r.employee.socialInsurance).toBe(3_744_000);
    expect(r.employee.healthInsurance).toBe(702_000);
    expect(r.employee.unemployment).toBe(600_000);
    expect(r.employee.total).toBe(5_046_000);

    // NSDLĐ: 17%, 3%, 0,5% trên 46,8tr; 1% BHTN trên 60tr
    expect(r.employer.socialInsurance).toBe(7_956_000);
    expect(r.employer.healthInsurance).toBe(1_404_000);
    expect(r.employer.unemployment).toBe(600_000);
    expect(r.employer.accident).toBe(234_000);
    expect(r.employer.total).toBe(10_194_000);
  });

  it('mức tham chiếu đổi 2.340.000 → 2.530.000 thì trần và số đóng đổi theo', () => {
    const inp = { contributionSalary: 60_000_000, wageRegion: 'I' as const, trainedWorker: true };
    const before = calculateSocialInsurance(inp, BEFORE);
    const after = calculateSocialInsurance(inp, AFTER);

    expect(after.siCap).toBe(50_600_000); // 20 × 2.530.000
    expect(after.employee.socialInsurance).toBe(4_048_000); // 8% × 50,6tr
    expect(after.employer.socialInsurance).toBe(8_602_000); // 17%
    expect(after.employer.accident).toBe(253_000); // 0,5%
    // BHTN không đổi: trần theo vùng, không theo mức tham chiếu
    expect(after.employee.unemployment).toBe(before.employee.unemployment);
  });

  it('lương dưới sàn → kẹp lên mức tham chiếu (BHXH) và lên lương tối thiểu vùng (BHTN)', () => {
    const r = calculateSocialInsurance(
      { contributionSalary: 2_000_000, wageRegion: 'IV' },
      BEFORE,
    );
    expect(r.siBase).toBe(2_340_000); // sàn = mức tham chiếu
    expect(r.siHitFloor).toBe(true);
    expect(r.uiBase).toBe(3_700_000); // sàn = lương tối thiểu vùng IV
    expect(r.uiHitFloor).toBe(true);

    expect(r.employee.socialInsurance).toBe(187_200); // 8% × 2.340.000
    expect(r.employee.healthInsurance).toBe(35_100); // 1,5%
    expect(r.employee.unemployment).toBe(37_000); // 1% × 3.700.000
    expect(r.employee.total).toBe(259_300);

    expect(r.employer.socialInsurance).toBe(397_800); // 17%
    expect(r.employer.healthInsurance).toBe(70_200); // 3%
    expect(r.employer.accident).toBe(11_700); // 0,5%
    expect(r.employer.total).toBe(516_700);
  });

  it('+7% cho lao động đã qua đào tạo áp vào SÀN BHTN, không phải trần, không phải BHXH', () => {
    const trained = calculateSocialInsurance(
      { contributionSalary: 4_000_000, wageRegion: 'I', trainedWorker: true },
      BEFORE,
    );
    const notTrained = calculateSocialInsurance(
      { contributionSalary: 4_000_000, wageRegion: 'I', trainedWorker: false },
      BEFORE,
    );

    // 5.310.000 × 1,07 = 5.681.700
    expect(trained.uiFloor).toBe(5_681_700);
    expect(notTrained.uiFloor).toBe(5_310_000);
    expect(trained.uiBase).toBe(5_681_700);
    expect(notTrained.uiBase).toBe(5_310_000);

    // Trần BHTN KHÔNG đổi theo cờ đào tạo
    expect(trained.uiCap).toBe(notTrained.uiCap);
    // Căn cứ BHXH/BHYT KHÔNG đổi theo cờ đào tạo
    expect(trained.siBase).toBe(notTrained.siBase);
  });

  it('kỳ nửa tháng: kẹp theo trần THÁNG rồi mới nhân tỷ lệ', () => {
    const r = calculateSocialInsurance(
      { contributionSalary: 60_000_000, wageRegion: 'I', monthsInPeriod: 0.5 },
      BEFORE,
    );
    // Căn cứ vẫn là trần tháng 46,8tr (không phải 30tr), số tiền mới nhân 0,5
    expect(r.siBase).toBe(46_800_000);
    expect(r.employee.socialInsurance).toBe(1_872_000); // 8% × 46,8tr × 0,5
  });
});

describe('Engine BHXH: ném lỗi thay vì tính bừa', () => {
  it('vùng không có trong bộ tham số → ném lỗi, không lấy vùng đầu tiên làm mặc định', () => {
    const partial: VnSiParams = {
      ...BEFORE,
      regionalMinimumWages: [{ region: 'I', monthly: 5_310_000 }],
    };
    expect(() => regionalMinimumWage(partial, 'IV')).toThrow(/không khai báo/);
    expect(() =>
      calculateSocialInsurance({ contributionSalary: 10_000_000, wageRegion: 'IV' }, partial),
    ).toThrow(/Vùng IV/);
  });

  it('lương NaN → ném lỗi (NaN lan ra mọi khoản trích)', () => {
    expect(() =>
      calculateSocialInsurance(
        { contributionSalary: Number.NaN, wageRegion: 'I' },
        BEFORE,
      ),
    ).toThrow(RangeError);
  });

  it('lương âm → ném lỗi', () => {
    expect(() =>
      calculateSocialInsurance({ contributionSalary: -1, wageRegion: 'I' }, BEFORE),
    ).toThrow(/không được âm/);
  });

  it('monthsInPeriod ngoài (0,1] → ném lỗi', () => {
    for (const m of [0, -0.5, 1.5, Number.NaN]) {
      expect(() =>
        calculateSocialInsurance(
          { contributionSalary: 10_000_000, wageRegion: 'I', monthsInPeriod: m },
          BEFORE,
        ),
      ).toThrow(RangeError);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. GIAO DIỆN TỰ SINH — loại chính sách này KHÔNG có form viết tay
// ---------------------------------------------------------------------------

describe('VN_BHXH: form tự sinh từ JSON Schema', () => {
  it('defaultsFromSchema sinh đủ mọi trường, kể cả object lồng và mảng vùng', () => {
    const d = defaultsFromSchema(SCHEMA);
    expect(Object.keys(d).sort()).toEqual(Object.keys(SCHEMA.properties ?? {}).sort());
    expect(d.regionalMinimumWages).toEqual([]);
    expect(d.employee).toEqual({
      socialInsurance: 0,
      healthInsurance: 0,
      unemployment: 0,
    });
    expect(d.employer).toHaveProperty('accident');
  });

  it('giá trị mặc định KHÔNG được phép lưu — form phải bắt người dùng điền', () => {
    const issues = validateAgainstSchema(SCHEMA, defaultsFromSchema(SCHEMA));
    const paths = issues.map((i) => i.path.join('.'));
    expect(paths).toContain('regimeCode');
    expect(paths).toContain('regionalMinimumWages');
  });

  it('một bộ tham số đầy đủ thì form không báo lỗi nào', () => {
    const issues = validateAgainstSchema(SCHEMA, SEED_SI_FROM_2026_07);
    expect(issues).toEqual([]);
  });

  it('báo đúng đường dẫn tới dòng vùng bị thiếu', () => {
    const issues = validateAgainstSchema(SCHEMA, {
      ...SEED_SI_FROM_2026_07,
      regionalMinimumWages: [
        { region: 'I', monthly: 5_310_000 },
        { region: 'II' },
      ],
    });
    expect(issues.map((i) => i.path.join('.'))).toContain('regionalMinimumWages.1.monthly');
  });
});
