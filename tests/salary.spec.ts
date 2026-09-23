/**
 * ============================================================================
 * TEST — CÔNG THỨC LƯƠNG (schema + engine)
 * ============================================================================
 *
 * Mọi số kỳ vọng trong file này được TÍNH TAY từ công thức trong seed. Nếu
 * engine sai thì test đỏ.
 *
 * Nhân viên mẫu:
 *   baseSalary 25.000.000 · workedDays 22 · standardDays 22 · kpiScore 85
 *   hourlyRate 120.000 · OT 10h thường + 4h cuối tuần + 0h lễ
 *   mealDays 22 · lateCount 5 · advanceAmount 2.000.000
 */
import { describe, it, expect } from 'vitest';
import {
  vnSalaryParamsSchema,
  vnSalaryJsonSchema,
  SEED_SALARY_VN_STD,
  type VnSalaryParams,
} from '../src/policy/salary-params.js';
import { calculateSalary } from '../src/engine/salary.js';
import { evalFormula } from '../src/engine/formula.js';
import { expectSchemasAgree } from './helpers.js';

const VARS = {
  baseSalary: 25_000_000,
  workedDays: 22,
  standardDays: 22,
  kpiScore: 85,
  // OT BAN NGÀY (đã trừ phần đêm)
  otNormalHours: 10,
  otWeekendHours: 4,
  otHolidayHours: 0,
  // 5 ca đêm × 8 giờ
  nightHours: 40,
  // OT ban đêm, mỗi biến một hệ số theo Điều 57 NĐ 145/2020
  otNightNormalWithDayOtHours: 2,
  otNightNormalNoDayOtHours: 3,
  otNightWeekendHours: 1,
  otNightHolidayHours: 0,
  hourlyRate: 120_000,
  mealDays: 22,
  lateCount: 5,
  advanceAmount: 2_000_000,
};

const byCode = (r: ReturnType<typeof calculateSalary>, code: string) =>
  r.components.find((c) => c.code === code);

// ---------------------------------------------------------------------------
// 1. SCHEMA
// ---------------------------------------------------------------------------

describe('VN_SALARY: JSON Schema và Zod schema khớp nhau', () => {
  it('cùng tập tên trường và cùng danh sách bắt buộc', () => {
    const { jsonFields } = expectSchemasAgree(vnSalaryJsonSchema, vnSalaryParamsSchema);
    expect(jsonFields).toContain('components');
    expect(jsonFields).toContain('inputVariables');
  });

  it('seed parse được', () => {
    expect(vnSalaryParamsSchema.safeParse(SEED_SALARY_VN_STD).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. RÀNG BUỘC LÚC LƯU — chặn trước khi có kỳ lương nào chạy
// ---------------------------------------------------------------------------

describe('VN_SALARY: ràng buộc chặn công thức sai lúc LƯU', () => {
  // THÊM một thành phần vào seed, không THAY cả mảng — thay cả mảng thì các
  // test về trùng mã / trùng thứ tự / tham chiếu chéo không còn ý nghĩa gì.
  const extra = (patch: Partial<VnSalaryParams['components'][number]>): VnSalaryParams => ({
    ...SEED_SALARY_VN_STD,
    components: [
      ...SEED_SALARY_VN_STD.components,
      {
        code: 'X',
        label: 'X',
        formula: 'baseSalary',
        sequence: 100,
        taxable: false,
        inInsuranceBase: false,
        allowNegative: false,
        ...patch,
      },
    ],
  });

  it('công thức sai cú pháp bị chặn', () => {
    const r = vnSalaryParamsSchema.safeParse(extra({ formula: 'baseSalary *+' }));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/sai cú pháp/);
  });

  it('biến không khai báo bị chặn — đây là chỗ chặn lỗi gõ sai tên biến', () => {
    const r = vnSalaryParamsSchema.safeParse(
      extra({ formula: 'round(baseSalry * 2)' }), // gõ thiếu chữ a
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/baseSalry/);
  });

  it('tham chiếu tới thành phần tính SAU bị chặn — đây là chỗ chống vòng lặp', () => {
    // TAM_UNG có sequence 60. Đặt X ở 25 thì TAM_UNG chưa được tính.
    const r = vnSalaryParamsSchema.safeParse(
      extra({ formula: 'TAM_UNG + 1', sequence: 25 }),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/chưa khai báo/);
    expect(r.error?.issues[0]?.message).toMatch(/TAM_UNG/);
  });

  it('tham chiếu tới thành phần tính TRƯỚC thì hợp lệ', () => {
    // LUONG_CO_BAN có sequence 10, X đặt ở 100 → đã tính xong
    const r = vnSalaryParamsSchema.safeParse(
      extra({ formula: 'LUONG_CO_BAN + 1', sequence: 100 }),
    );
    expect(r.success).toBe(true);
  });

  it('trùng mã thành phần bị chặn', () => {
    const r = vnSalaryParamsSchema.safeParse(
      extra({ code: 'LUONG_CO_BAN', formula: 'baseSalary', sequence: 100 }),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/bị trùng/);
  });

  it('trùng thứ tự bị chặn — nếu không kết quả phụ thuộc vào vị trí trong bảng', () => {
    const r = vnSalaryParamsSchema.safeParse(
      extra({ code: 'KHAC', formula: 'baseSalary', sequence: 10 }),
    );
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/Thứ tự 10 bị trùng/);
  });

  it('mã thành phần không phải định danh hợp lệ bị chặn', () => {
    for (const bad of ['1ABC', 'CO DAU', 'a-b', '']) {
      expect(vnSalaryParamsSchema.safeParse(extra({ code: bad })).success).toBe(false);
    }
  });

  it('biến đầu vào trùng mã thành phần bị chặn', () => {
    const r = vnSalaryParamsSchema.safeParse({
      ...SEED_SALARY_VN_STD,
      inputVariables: [...SEED_SALARY_VN_STD.inputVariables, 'LUONG_CO_BAN'],
    });
    expect(r.success).toBe(false);
  });

  it('gán và truy cập phần tử bị chặn ngay lúc parse', () => {
    for (const f of ['x = 1', 'a[0]', 'a += 1']) {
      expect(vnSalaryParamsSchema.safeParse(extra({ formula: f })).success).toBe(false);
    }
  });

  /**
   * Ba test dưới đây tách bạch hai chuyện dễ nhầm:
   *   - "parse được" KHÔNG có nghĩa là "chạy được". Không có eval, nên một
   *     tên hàm lạ chỉ làm bộ tra hàm trượt và ném lỗi.
   *   - RÒ RỈ CHUỖI PROTOTYPE là lỗi thật đã phát hiện: `in` trả về true cho
   *     'constructor' và '__proto__' trong MỌI ngữ cảnh, nên evaluator từng
   *     trả về chính hàm Object. Đã sửa sang hasOwnProperty.
   */
  it('process.exit / globalThis.constructor parse được nhưng KHÔNG thực thi được', () => {
    expect(() => evalFormula('process.exit(1)', {}, { onMissingVar: 'throw' })).toThrow(
      /không tồn tại/,
    );
    expect(() =>
      evalFormula('globalThis.constructor', {}, { onMissingVar: 'throw' }),
    ).toThrow(/chưa được khai báo/);
  });

  it('constructor / __proto__ không rò rỉ qua chuỗi prototype', () => {
    for (const f of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(() => evalFormula(f, {}, { onMissingVar: 'throw' })).toThrow(
        /chưa được khai báo/,
      );
    }
  });

  it('ngữ cảnh có prototype cũng không rò rỉ (hasOwnProperty, không phải `in`)', () => {
    const ctx = { baseSalary: 1_000_000 };
    expect(evalFormula('baseSalary', ctx, { onMissingVar: 'throw' })).toBe(1_000_000);
    expect(() => evalFormula('constructor', ctx, { onMissingVar: 'throw' })).toThrow(
      /chưa được khai báo/,
    );
  });
});

// ---------------------------------------------------------------------------
// 3. ENGINE — SỐ TÍNH TAY
// ---------------------------------------------------------------------------

describe('Engine lương: tính đúng từng thành phần', () => {
  const r = calculateSalary({ variables: VARS }, SEED_SALARY_VN_STD);

  it('lương cơ bản chia theo ngày công chuẩn, không chia cứng 26', () => {
    // 25.000.000 × 22/22 = 25.000.000
    expect(byCode(r, 'LUONG_CO_BAN')?.amount).toBe(25_000_000);
  });

  it('OT ban ngày: 150% / 200% / 300%', () => {
    // 120.000 × (10×1,5 + 4×2 + 0×3) = 120.000 × 23 = 2.760.000
    expect(byCode(r, 'LUONG_OT')?.amount).toBe(2_760_000);
  });

  it('phụ cấp làm đêm 30% — Điều 98 khoản 2', () => {
    // 120.000 × 40 giờ × 30% = 1.440.000
    expect(byCode(r, 'PHU_CAP_LAM_DEM')?.amount).toBe(1_440_000);
  });

  it('OT ban đêm: BỐN hệ số khác nhau, không gộp làm một', () => {
    // 120.000 × (2×2,1 + 3×2,0 + 1×2,7 + 0×3,9)
    //         = 120.000 × (4,2 + 6,0 + 2,7 + 0) = 120.000 × 12,9 = 1.548.000
    // Nếu gộp hai trường hợp ngày thường thành 2,0 thì thiếu 2×0,1×120.000 = 24.000đ.
    expect(byCode(r, 'LUONG_OT_DEM')?.amount).toBe(1_548_000);
  });

  it('giờ đêm không bị trả hai lần (OT ngày và OT đêm rời nhau)', () => {
    // otNight* là phần ĐÊM, ot*Hours là phần BAN NGÀY — hai tập rời nhau nên cộng
    // hai thành phần không nhân đôi giờ nào. Kiểm bằng cách cho 1 giờ OT đêm và
    // 0 giờ OT ngày: tổng phải đúng bằng 210% của một giờ, không phải 360%.
    const one = calculateSalary(
      {
        variables: {
          ...VARS,
          otNormalHours: 0,
          otWeekendHours: 0,
          otHolidayHours: 0,
          otNightNormalWithDayOtHours: 1,
          otNightNormalNoDayOtHours: 0,
          otNightWeekendHours: 0,
          otNightHolidayHours: 0,
          nightHours: 0,
        },
      },
      SEED_SALARY_VN_STD,
    );
    expect(byCode(one, 'LUONG_OT')?.amount).toBe(0);
    expect(byCode(one, 'LUONG_OT_DEM')?.amount).toBe(252_000); // 120.000 × 2,1
    expect(byCode(one, 'PHU_CAP_LAM_DEM')?.amount).toBe(0);
  });

  it('thành phần sau dùng được kết quả thành phần trước', () => {
    // 25.000.000 × 85/100 = 21.250.000
    expect(byCode(r, 'LUONG_KPI')?.amount).toBe(21_250_000);
  });

  it('OT đúng 150/200/300%', () => {
    // 120.000 × (10×1,5 + 4×2 + 0×3) = 120.000 × 23 = 2.760.000
    expect(byCode(r, 'LUONG_OT')?.amount).toBe(2_760_000);
  });

  it('khấu trừ ra số âm và được giữ nguyên dấu', () => {
    // (5 − 3) × 50.000 = 100.000 → −100.000
    expect(byCode(r, 'PHAT_DI_MUON')?.amount).toBe(-100_000);
    expect(byCode(r, 'TAM_UNG')?.amount).toBe(-2_000_000);
  });

  it('tổng thu nhập / khấu trừ / ròng', () => {
    //   lương cơ bản      25.000.000
    // + KPI 85%           21.250.000
    // + OT ban ngày        2.760.000
    // + OT ban đêm         1.548.000   ← mới (Điều 57 NĐ 145/2020)
    // + phụ cấp đêm 30%    1.440.000   ← mới (Điều 98 khoản 2)
    // + ăn giữa ca           660.000
    // =                   52.658.000
    expect(r.earningsTotal).toBe(52_658_000);
    expect(r.deductionsTotal).toBe(-2_100_000);
    expect(r.netFromComponents).toBe(50_558_000);
  });

  it('chỉ thành phần có cờ mới vào thu nhập chịu thuế và căn cứ bảo hiểm', () => {
    // Cả 6 khoản dương đều taxable — phụ cấp đêm và OT đêm là thu nhập chịu thuế.
    expect(r.taxableIncome).toBe(52_658_000);
    // Chỉ LUONG_CO_BAN bật inInsuranceBase — KPI/OT/phụ cấp đêm/ăn ca thì không.
    expect(r.insuranceBaseSalary).toBe(25_000_000);
  });

  it('khấu trừ KHÔNG làm giảm thu nhập chịu thuế', () => {
    // Tạm ứng là khoản ứng trước, không phải giảm trừ theo luật. Nếu trừ vào
    // đây thì nhà nước thất thu và người lao động được hoàn vô lý.
    expect(r.taxableIncome).toBe(r.earningsTotal);
  });

  it('kỳ ngắn ngày: lương cơ bản giảm theo tỷ lệ ngày công', () => {
    const r2 = calculateSalary(
      { variables: { ...VARS, workedDays: 11, kpiScore: 0, otNormalHours: 0, otWeekendHours: 0, mealDays: 11, lateCount: 0, advanceAmount: 0 } },
      SEED_SALARY_VN_STD,
    );
    // 25.000.000 × 11/22 = 12.500.000
    expect(byCode(r2, 'LUONG_CO_BAN')?.amount).toBe(12_500_000);
  });
});

describe('Engine lương: ném lỗi thay vì trả 0 âm thầm', () => {
  it('thiếu biến đầu vào → ném lỗi, KHÔNG suy ra 0', () => {
    const { kpiScore: _omit, ...rest } = VARS;
    expect(() => calculateSalary({ variables: rest }, SEED_SALARY_VN_STD)).toThrow(
      /Thiếu biến đầu vào 'kpiScore'/,
    );
  });

  it('biến NaN → ném lỗi', () => {
    expect(() =>
      calculateSalary({ variables: { ...VARS, baseSalary: Number.NaN } }, SEED_SALARY_VN_STD),
    ).toThrow(/không hữu hạn/);
  });

  it('biến dùng trong công thức nhưng không có trong ngữ cảnh → ném lỗi (onMissingVar: throw)', () => {
    // Bypass superRefine bằng cách đưa schema đã parse sẵn: giả lập một bộ
    // tham số lọt qua được (vd. thêm vào DB bằng SQL thô).
    const sneaky: VnSalaryParams = {
      ...SEED_SALARY_VN_STD,
      inputVariables: ['baseSalary'],
      components: [
        {
          code: 'X',
          label: 'X',
          formula: 'bienKhongTonTai * 2',
          sequence: 1,
          taxable: false,
          inInsuranceBase: false,
          allowNegative: false,
        },
      ],
    };
    expect(() =>
      calculateSalary({ variables: { baseSalary: 1_000_000 } }, sneaky),
    ).toThrow(/bienKhongTonTai/);
  });

  it('thành phần ra âm mà không cho phép âm → ném lỗi', () => {
    const bad: VnSalaryParams = {
      ...SEED_SALARY_VN_STD,
      inputVariables: ['x'],
      components: [
        {
          code: 'X',
          label: 'X',
          formula: 'x * -1',
          sequence: 1,
          taxable: false,
          inInsuranceBase: false,
          allowNegative: false,
        },
      ],
    };
    expect(() => calculateSalary({ variables: { x: 500_000 } }, bad)).toThrow(
      /ra số âm/,
    );
  });

  it('chia cho 0 → ném lỗi, không trả Infinity', () => {
    const bad: VnSalaryParams = {
      ...SEED_SALARY_VN_STD,
      inputVariables: ['a', 'b'],
      components: [
        {
          code: 'X',
          label: 'X',
          formula: 'a / b',
          sequence: 1,
          taxable: false,
          inInsuranceBase: false,
          allowNegative: false,
        },
      ],
    };
    expect(() => calculateSalary({ variables: { a: 1, b: 0 } }, bad)).toThrow(/Chia cho 0/);
  });
});
