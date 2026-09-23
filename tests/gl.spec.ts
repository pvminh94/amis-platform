/**
 * Test cầu nối HR → sổ cái.
 *
 * Bất biến mạnh nhất: sau ba bút toán, tài khoản 334 phải BẰNG 0. Nếu còn dư
 * thì hoặc ghi thiếu hoặc ghi trùng — và đó là phép thử bắt được cả hai.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSalaryJournals,
  assertBalanced,
  accountBalances,
  GlError,
  type GlEntry,
  type PayslipForGl,
} from '../src/engine/gl';
import { SEED_GL_MAP_VN, glMapParamsSchema, REQUIRED_ACCOUNTS } from '../src/policy/gl-params';

const RUN = { id: 'run-1', periodYear: 2026, periodMonth: 9 };
const DATE = '2026-09-30';

/**
 * Số liệu LẤY TỪ DATABASE, không tính tay.
 *
 * Fixture đầu tiên tôi bịa số và nó tự mâu thuẫn: siEmployer = 4.532.500 nhưng
 * bốn khoản chi tiết cộng lại chỉ 4.392.130. Bút toán lập tức không cân và test
 * nổ ngay — đúng việc của bất biến. Bài học: fixture kế toán phải lấy từ dữ
 * liệu đã tính thật, vì "cộng tay cho khớp" là cách nhanh nhất để tạo ra một
 * bộ số trông đúng nhưng sai.
 */
function slip(over: Partial<PayslipForGl> = {}): PayslipForGl {
  return {
    employeeCode: 'NV001',
    fullName: 'Nguyễn Văn An',
    department: 'Kỹ thuật',
    earningsTotal: 42_674_615,
    deductionsTotal: -2_100_000,
    siEmployee: 2_221_154,
    siEmployer: 4_548_076,
    pit: 1_375_346,
    netPay: 36_978_115,
    siBreakdown: {
      employee: { social: 1_692_308, health: 317_308, unemployment: 211_538 },
      employer: { social: 3_596_154, health: 634_615, unemployment: 211_538, accident: 105_769 },
    },
    ...over,
  };
}

describe('seed ánh xạ kế toán phải hợp lệ theo chính schema của nó', () => {
  it('parse sạch', () => {
    const r = glMapParamsSchema.safeParse(SEED_GL_MAP_VN);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
    expect(r.success).toBe(true);
  });

  it('có đủ mọi tài khoản nghiệp vụ bắt buộc', () => {
    for (const k of REQUIRED_ACCOUNTS) {
      expect(SEED_GL_MAP_VN.accounts[k], k).toBeDefined();
    }
  });

  it('không tài khoản nghiệp vụ nào trùng số hiệu', () => {
    // 334 mà trùng với 3335 thì bút toán tự triệt tiêu và sổ VẪN CÂN — loại
    // lỗi không thể phát hiện bằng đối chiếu tổng.
    const codes = Object.values(SEED_GL_MAP_VN.accounts);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('schema chặn ánh xạ trùng số hiệu', () => {
    const bad = {
      ...SEED_GL_MAP_VN,
      accounts: { ...SEED_GL_MAP_VN.accounts, pitPayable: '334' },
    };
    const r = glMapParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toMatch(/tự triệt tiêu/);
  });

  it('schema chặn thiếu tài khoản nghiệp vụ', () => {
    const { pitPayable: _omit, ...rest } = SEED_GL_MAP_VN.accounts;
    void _omit;
    const r = glMapParamsSchema.safeParse({ ...SEED_GL_MAP_VN, accounts: rest });
    expect(r.success).toBe(false);
  });

  it('schema chặn số hiệu không phải số', () => {
    const r = glMapParamsSchema.safeParse({
      ...SEED_GL_MAP_VN,
      accounts: { ...SEED_GL_MAP_VN.accounts, payableSalary: 'TK334' },
    });
    expect(r.success).toBe(false);
  });
});

describe('buildSalaryJournals — cấu trúc', () => {
  const entries = buildSalaryJournals(RUN, [slip()], SEED_GL_MAP_VN, DATE);

  it('sinh đúng ba bút toán theo thứ tự', () => {
    expect(entries.map((e) => e.entryType)).toEqual([
      'SALARY_ACCRUAL',
      'SALARY_DEDUCTION',
      'SALARY_PAYMENT',
    ]);
  });

  it('mỗi bút toán đều cân Nợ = Có', () => {
    for (const e of entries) {
      expect(e.totalDebit, e.entryNo).toBe(e.totalCredit);
    }
  });

  it('entryNo duy nhất và mang thông tin kỳ — để chống ghi trùng', () => {
    const nos = entries.map((e) => e.entryNo);
    expect(new Set(nos).size).toBe(3);
    expect(nos[0]).toBe('PR-2026-09-ACCRUAL');
    expect(nos[2]).toBe('PR-2026-09-PAY');
  });

  it('chi phí vào đúng tài khoản theo bộ phận', () => {
    const accrual = entries[0]!;
    const line = accrual.lines.find((l) => l.account === '6422' && l.side === 'DEBIT');
    expect(line).toBeDefined();
    // Chi phí = thu nhập + bảo hiểm phía DN
    expect(line!.amount).toBe(42_674_615 + 4_548_076);
  });

  it('bộ phận Sản xuất vào 154, không phải 6422', () => {
    const e = buildSalaryJournals(
      RUN,
      [slip({ department: 'Sản xuất', employeeCode: 'NV007' })],
      SEED_GL_MAP_VN,
      DATE,
    );
    expect(e[0]!.lines.some((l) => l.account === '154' && l.side === 'DEBIT')).toBe(true);
    expect(e[0]!.lines.some((l) => l.account === '6422')).toBe(false);
  });

  it('bộ phận chưa ánh xạ rơi vào tài khoản mặc định chứ không ném', () => {
    const e = buildSalaryJournals(
      RUN,
      [slip({ department: 'Phòng mới lập' })],
      SEED_GL_MAP_VN,
      DATE,
    );
    expect(e[0]!.lines.some((l) => l.account === SEED_GL_MAP_VN.defaultExpenseAccount)).toBe(true);
  });

  it('bảo hiểm phía DN tách đúng 3383 / 3384 / 3386 / 3388', () => {
    const a = entries[0]!;
    const find = (code: string) => a.lines.find((l) => l.account === code && l.side === 'CREDIT');
    expect(find('3383')?.amount).toBe(3_596_154);
    expect(find('3384')?.amount).toBe(634_615);
    expect(find('3386')?.amount).toBe(211_538);
    expect(find('3388')?.amount).toBe(105_769);
  });

  it('thuế vào 3335, tạm ứng vào 141', () => {
    const d = entries[1]!;
    expect(d.lines.find((l) => l.account === '3335')?.amount).toBe(1_375_346);
    expect(d.lines.find((l) => l.account === '141')?.amount).toBe(2_100_000);
  });

  it('trả lương Nợ 334 / Có 1121 bằng đúng thực nhận', () => {
    const p = entries[2]!;
    expect(p.lines).toHaveLength(2);
    expect(p.lines.find((l) => l.account === '334')?.side).toBe('DEBIT');
    expect(p.lines.find((l) => l.account === '1121')?.side).toBe('CREDIT');
    expect(p.totalDebit).toBe(36_978_115);
  });
});

describe('BẤT BIẾN: 334 phải bằng 0 sau ba bút toán', () => {
  it('một nhân viên', () => {
    const entries = buildSalaryJournals(RUN, [slip()], SEED_GL_MAP_VN, DATE);
    const bal = accountBalances(entries);
    expect(bal.get('334')).toBe(0);
  });

  it('nhiều nhân viên, nhiều bộ phận', () => {
    const slips = [
      slip(),
      slip({ employeeCode: 'NV002', department: 'Kỹ thuật', earningsTotal: 70_310_000, siEmployee: 3_360_000, siEmployer: 6_880_000, pit: 4_310_000, netPay: 62_640_000, deductionsTotal: 0,
        siBreakdown: { employee: { social: 2_560_000, health: 480_000, unemployment: 320_000 }, employer: { social: 5_440_000, health: 960_000, unemployment: 320_000, accident: 160_000 } } }),
      slip({ employeeCode: 'NV007', department: 'Sản xuất', earningsTotal: 24_780_000, siEmployee: 1_260_000, siEmployer: 2_580_000, pit: 0, netPay: 23_520_000, deductionsTotal: 0,
        siBreakdown: { employee: { social: 960_000, health: 180_000, unemployment: 120_000 }, employer: { social: 2_040_000, health: 360_000, unemployment: 120_000, accident: 60_000 } } }),
    ];
    const entries = buildSalaryJournals(RUN, slips, SEED_GL_MAP_VN, DATE);
    for (const e of entries) expect(e.totalDebit, e.entryNo).toBe(e.totalCredit);
    expect(accountBalances(entries).get('334')).toBe(0);
  });

  it('kỳ không có khấu trừ nào vẫn cân', () => {
    const entries = buildSalaryJournals(
      RUN,
      [slip({ deductionsTotal: 0, pit: 0 })],
      SEED_GL_MAP_VN,
      DATE,
    );
    // Bút toán khấu trừ lúc này chỉ còn bảo hiểm NLĐ
    expect(entries[1]!.totalDebit).toBe(2_221_154);
    // 334 không còn bằng 0 vì chưa trừ khoản tạm ứng — nhưng vẫn cân từng bút toán
    for (const e of entries) expect(e.totalDebit).toBe(e.totalCredit);
  });
});

describe('dữ liệu hỏng phải bị chặn, không âm thầm ghi sổ sai', () => {
  it('thiếu chi tiết bảo hiểm thì NÉM — không gộp vào "phải trả khác"', () => {
    expect(() =>
      buildSalaryJournals(RUN, [slip({ siBreakdown: null })], SEED_GL_MAP_VN, DATE),
    ).toThrow(/thiếu chi tiết bảo hiểm/);
  });

  it('số tiền NaN bị chặn', () => {
    expect(() =>
      buildSalaryJournals(RUN, [slip({ pit: Number.NaN })], SEED_GL_MAP_VN, DATE),
    ).toThrow(/không hữu hạn/);
  });

  it('không có phiếu nào thì ném, không sinh bút toán rỗng', () => {
    expect(() => buildSalaryJournals(RUN, [], SEED_GL_MAP_VN, DATE)).toThrow(/không có phiếu/);
  });

  it('ánh xạ thiếu tài khoản nghiệp vụ thì ném lúc ghi', () => {
    const bad = {
      ...SEED_GL_MAP_VN,
      accounts: { ...SEED_GL_MAP_VN.accounts, bankVnd: undefined as unknown as string },
    };
    expect(() => buildSalaryJournals(RUN, [slip()], bad, DATE)).toThrow(/MISSING_ACCOUNT|thiếu tài khoản/i);
  });
});

describe('chi tiết bảo hiểm phải khớp tổng đã lưu', () => {
  it('lệch một đồng cũng bị chặn', () => {
    const bad = slip();
    bad.siBreakdown = {
      ...bad.siBreakdown!,
      employer: { social: 3_596_155, health: 634_615, unemployment: 211_538, accident: 105_769 },
    };
    // Tổng chi tiết giờ là 4.548.077 trong khi siEmployer vẫn 4.548.076.
    // Bút toán VẪN SẼ CÂN nếu bỏ qua kiểm tra này, nhưng sổ cái sẽ khác bảng lương.
    try {
      buildSalaryJournals(RUN, [bad], SEED_GL_MAP_VN, DATE);
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect((e as GlError).code).toBe('SI_BREAKDOWN_MISMATCH');
    }
  });
});

describe('assertBalanced', () => {
  it('chênh lệch dù một đồng cũng bị chặn', () => {
    const e: GlEntry = {
      entryNo: 'X',
      entryType: 'SALARY_ACCRUAL',
      postingDate: DATE,
      periodYear: 2026,
      periodMonth: 9,
      memo: '',
      sourceType: 'PAY_RUN',
      sourceId: 'run-1',
      lines: [
        { account: '6422', side: 'DEBIT', amount: 100 },
        { account: '334', side: 'CREDIT', amount: 99 },
      ],
      totalDebit: 100,
      totalCredit: 99,
    };
    expect(() => assertBalanced(e)).toThrow(/không cân/);
  });

  it('bút toán một bên bị chặn', () => {
    const e: GlEntry = {
      entryNo: 'X',
      entryType: 'SALARY_ACCRUAL',
      postingDate: DATE,
      periodYear: 2026,
      periodMonth: 9,
      memo: '',
      sourceType: 'PAY_RUN',
      sourceId: 'run-1',
      lines: [{ account: '6422', side: 'DEBIT', amount: 100 }],
      totalDebit: 100,
      totalCredit: 100,
    };
    expect(() => assertBalanced(e)).toThrow(/ít nhất hai/);
  });
});

describe('gộp dòng — sổ cái không cần 500 dòng giống nhau', () => {
  it('hai nhân viên cùng bộ phận gộp thành một dòng chi phí', () => {
    const entries = buildSalaryJournals(
      RUN,
      [slip(), slip({ employeeCode: 'NV010' })],
      SEED_GL_MAP_VN,
      DATE,
    );
    const expenseLines = entries[0]!.lines.filter((l) => l.account === '6422');
    expect(expenseLines).toHaveLength(1);
    expect(expenseLines[0]!.amount).toBe((42_674_615 + 4_548_076) * 2);
  });

  it('dòng 0 đồng bị loại bỏ', () => {
    const entries = buildSalaryJournals(
      RUN,
      [slip({ pit: 0, deductionsTotal: 0, siEmployee: 0, siBreakdown: {
        employee: { social: 0, health: 0, unemployment: 0 },
        employer: { social: 3_596_154, health: 634_615, unemployment: 211_538, accident: 105_769 },
      } })],
      SEED_GL_MAP_VN,
      DATE,
    );
    // Không dòng nào bằng 0 — dòng 0 không đổi số dư nhưng làm rối sổ
    for (const e of entries) {
      for (const l of e.lines) expect(l.amount, `${e.entryNo} ${l.account}`).toBeGreaterThan(0);
    }
  });

  it('không ai có khấu trừ thì bỏ qua bút toán khấu trừ — không tạo bút toán rỗng', () => {
    const entries = buildSalaryJournals(
      RUN,
      [
        slip({
          pit: 0,
          deductionsTotal: 0,
          siEmployee: 0,
          siBreakdown: {
            employee: { social: 0, health: 0, unemployment: 0 },
            employer: { social: 3_596_154, health: 634_615, unemployment: 211_538, accident: 105_769 },
          },
        }),
      ],
      SEED_GL_MAP_VN,
      DATE,
    );

    // Một bút toán rỗng tệ hơn không có gì: nó nằm trong sổ cái như thể đã hạch
    // toán một nghiệp vụ không tồn tại.
    expect(entries.map((e) => e.entryType)).toEqual(['SALARY_ACCRUAL', 'SALARY_PAYMENT']);
    expect(entries.every((e) => e.lines.length >= 2)).toBe(true);
  });
});

describe('GlError mang mã để tầng API trả đúng status', () => {
  it('lỗi là thể hiện của GlError với code', () => {
    try {
      buildSalaryJournals(RUN, [slip({ siBreakdown: null })], SEED_GL_MAP_VN, DATE);
      throw new Error('đáng lẽ phải ném');
    } catch (e) {
      expect(e).toBeInstanceOf(GlError);
      expect((e as GlError).code).toBe('MISSING_SI_BREAKDOWN');
    }
  });
});
