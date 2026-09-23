/**
 * ============================================================================
 * CẦU NỐI HR → SỔ CÁI — kế toán kép
 * ============================================================================
 *
 * BA BÚT TOÁN CHO MỖI KỲ LƯƠNG, và thứ tự của chúng có ý nghĩa:
 *
 *   1. GHI NHẬN CHI PHÍ (accrual)
 *        Nợ 6421/6422/154  = tổng thu nhập + bảo hiểm phía DN
 *        Có 334            = tổng thu nhập
 *        Có 3383/3384/3386/3388 = bảo hiểm phía DN
 *      Chi phí phải được ghi nhận ở kỳ nó phát sinh, không phải kỳ trả tiền.
 *
 *   2. TRÍCH CÁC KHOẢN KHẤU TRỪ
 *        Nợ 334            = bảo hiểm NLĐ + thuế + khấu trừ khác
 *        Có 3383/3384/3386 = bảo hiểm phần người lao động
 *        Có 3335           = thuế TNCN
 *        Có 141            = tạm ứng
 *      Đây là lúc công ty trở thành người NỘP HỘ — nợ người lao động giảm,
 *      nợ cơ quan bảo hiểm và cơ quan thuế tăng.
 *
 *   3. TRẢ LƯƠNG QUA NGÂN HÀNG
 *        Nợ 334  = thực nhận
 *        Có 1121 = thực nhận
 *
 * Sau ba bút toán, số dư 334 phải BẰNG 0 — đó là phép thử mạnh nhất: nếu còn
 * dư thì hoặc ghi thiếu, hoặc ghi trùng.
 */

import type { GlMapParams, RequiredAccountKey } from '@/policy/gl-params';

export interface GlLine {
  account: string;
  side: 'DEBIT' | 'CREDIT';
  amount: number;
  memo?: string;
}

export interface GlEntry {
  entryNo: string;
  entryType: 'SALARY_ACCRUAL' | 'SALARY_DEDUCTION' | 'SALARY_PAYMENT';
  postingDate: string;
  periodYear: number;
  periodMonth: number;
  memo: string;
  sourceType: string;
  sourceId: string;
  lines: GlLine[];
  totalDebit: number;
  totalCredit: number;
}

export interface PayslipForGl {
  employeeCode: string;
  fullName: string;
  department: string;
  earningsTotal: number;
  deductionsTotal: number;
  siEmployee: number;
  siEmployer: number;
  pit: number;
  netPay: number;
  siBreakdown?: {
    employee?: { social?: number; health?: number; unemployment?: number };
    employer?: {
      social?: number;
      health?: number;
      unemployment?: number;
      accident?: number;
    };
  } | null;
}

export interface PayRunForGl {
  id: string;
  periodYear: number;
  periodMonth: number;
}

export class GlError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GlError';
    this.code = code;
  }
}

/** Gom các dòng cùng tài khoản + cùng bên. Sổ cái không cần 500 dòng giống nhau. */
function mergeLines(lines: GlLine[]): GlLine[] {
  const map = new Map<string, GlLine>();
  for (const l of lines) {
    if (!Number.isFinite(l.amount)) {
      throw new GlError(
        'NOT_A_NUMBER',
        `Số tiền không hữu hạn ở tài khoản ${l.account}: ${l.amount}. ` +
          `Một ô trống trên bảng lương sẽ thành NaN và làm bút toán lệch mà không báo lỗi.`,
      );
    }
    if (l.amount < 0) {
      // Số âm phải được đảo bên, không phải ghi âm. Ghi "Nợ -100" và "Có 100"
      // là hai cách diễn đạt khác nhau của cùng một nghiệp vụ, và nếu để lẫn
      // thì không có cách nào đối chiếu tự động được.
      throw new GlError(
        'NEGATIVE_AMOUNT',
        `Số tiền âm ở tài khoản ${l.account}: ${l.amount}. Phải đảo bên Nợ/Có chứ không ghi số âm.`,
      );
    }
    if (l.amount === 0) continue; // dòng 0 đồng không đổi số dư, bỏ qua
    const key = `${l.account}:${l.side}`;
    const existing = map.get(key);
    if (existing) {
      existing.amount += l.amount;
    } else {
      map.set(key, { ...l });
    }
  }
  return [...map.values()];
}

function finalize(
  partial: Omit<GlEntry, 'lines' | 'totalDebit' | 'totalCredit'>,
  lines: GlLine[],
): GlEntry {
  const merged = mergeLines(lines);
  const totalDebit = merged.filter((l) => l.side === 'DEBIT').reduce((s, l) => s + l.amount, 0);
  const totalCredit = merged.filter((l) => l.side === 'CREDIT').reduce((s, l) => s + l.amount, 0);

  // CHƯA kiểm tra cân đối ở đây. buildSalaryJournals mới là nơi quyết định bút
  // toán nào thực sự phát sinh: một bút toán không có dòng nào thì không phải
  // "sai" mà là "không áp dụng", và sẽ bị bỏ qua thay vì ném lỗi.
  return { ...partial, lines: merged, totalDebit, totalCredit };
}

/**
 * TỔNG NỢ PHẢI BẰNG TỔNG CÓ.
 *
 * Đây là định nghĩa của kế toán kép, không phải một quy ước. Kiểm tra ở ĐÂY
 * (trước khi ghi) VÀ ở tầng database (CHECK constraint) — hai lớp, vì một con
 * đường ghi mới có thể quên gọi hàm này.
 */
export function assertBalanced(entry: GlEntry): void {
  if (entry.totalDebit !== entry.totalCredit) {
    throw new GlError(
      'UNBALANCED',
      `Bút toán ${entry.entryNo} không cân: Nợ ${entry.totalDebit} ≠ Có ${entry.totalCredit} ` +
        `(lệch ${entry.totalDebit - entry.totalCredit}).`,
    );
  }
  if (entry.lines.length < 2) {
    throw new GlError(
      'SINGLE_SIDED',
      `Bút toán ${entry.entryNo} chỉ có ${entry.lines.length} dòng. Kế toán kép cần ít nhất hai.`,
    );
  }
}

function acc(map: GlMapParams, key: RequiredAccountKey): string {
  const code = map.accounts[key];
  if (!code) {
    throw new GlError(
      'MISSING_ACCOUNT',
      `Ánh xạ '${map.regimeCode}' thiếu tài khoản '${key}'. Không ghi được bút toán.`,
    );
  }
  return code;
}

function expenseAccount(map: GlMapParams, department: string): string {
  return map.departmentAccounts[department] ?? map.defaultExpenseAccount;
}

/**
 * Dựng ba bút toán cho một kỳ lương.
 *
 * THUẦN TUÝ — không chạm database, nên test được toàn bộ số học mà không cần
 * PostgreSQL.
 */
export function buildSalaryJournals(
  run: PayRunForGl,
  slips: PayslipForGl[],
  map: GlMapParams,
  postingDate: string,
): GlEntry[] {
  if (slips.length === 0) {
    throw new GlError('NO_PAYSLIPS', `Kỳ ${run.periodMonth}/${run.periodYear} không có phiếu nào.`);
  }

  const meta = {
    postingDate,
    periodYear: run.periodYear,
    periodMonth: run.periodMonth,
    sourceType: 'PAY_RUN',
    sourceId: run.id,
  };
  const periodTag = `${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}`;

  // --- 1. GHI NHẬN CHI PHÍ ------------------------------------------------
  const accrual: GlLine[] = [];
  const deduction: GlLine[] = [];

  // Tổng bảo hiểm phía DN theo từng loại, để tách đúng tài khoản.
  const erSi = { social: 0, health: 0, unemployment: 0, accident: 0 };
  const eeSi = { social: 0, health: 0, unemployment: 0 };
  let grossTotal = 0;
  let pitTotal = 0;
  let netTotal = 0;
  let advanceTotal = 0;
  let eeSiTotal = 0;

  for (const s of slips) {
    const bd = s.siBreakdown;
    if (!bd || !bd.employer || !bd.employee) {
      // Không có chi tiết thì không tách được 3383/3384/3386. Thà dừng lại
      // còn hơn ghi một bút toán gộp vào "phải trả khác" rồi mất dấu.
      throw new GlError(
        'MISSING_SI_BREAKDOWN',
        `Phiếu của ${s.employeeCode} (${s.fullName}) thiếu chi tiết bảo hiểm. ` +
          `Không tách được 3383/3384/3386 — hãy chạy lại kỳ lương để lưu chi tiết.`,
      );
    }
    // TỔNG CHI TIẾT PHẢI BẰNG TỔNG ĐÃ LƯU.
    //
    // Hai con số này mô tả CÙNG MỘT sự thật và được lưu ở hai chỗ, nên chúng
    // CÓ THỂ lệch nhau — do một lần ghi dở, do sửa thẳng vào DB, hay do fixture
    // test bịa số. Nếu bỏ qua thì bút toán vẫn cân (vì cả hai bên đều lấy từ
    // chi tiết) nhưng tổng bảo hiểm trên sổ cái sẽ khác tổng trên bảng lương,
    // và không có cách nào phát hiện ra ngoài đối chiếu thủ công.
    const eeSum =
      (bd.employee.social ?? 0) + (bd.employee.health ?? 0) + (bd.employee.unemployment ?? 0);
    const erSum =
      (bd.employer.social ?? 0) +
      (bd.employer.health ?? 0) +
      (bd.employer.unemployment ?? 0) +
      (bd.employer.accident ?? 0);
    if (eeSum !== s.siEmployee || erSum !== s.siEmployer) {
      throw new GlError(
        'SI_BREAKDOWN_MISMATCH',
        `${s.employeeCode}: chi tiết bảo hiểm (${eeSum} NLĐ / ${erSum} NSDLĐ) không khớp ` +
          `tổng đã lưu (${s.siEmployee} / ${s.siEmployer}). Dữ liệu phiếu này hỏng — không ghi sổ.`,
      );
    }

    erSi.social += bd.employer.social ?? 0;
    erSi.health += bd.employer.health ?? 0;
    erSi.unemployment += bd.employer.unemployment ?? 0;
    erSi.accident += bd.employer.accident ?? 0;
    eeSi.social += bd.employee.social ?? 0;
    eeSi.health += bd.employee.health ?? 0;
    eeSi.unemployment += bd.employee.unemployment ?? 0;

    grossTotal += s.earningsTotal;
    pitTotal += s.pit;
    netTotal += s.netPay;
    eeSiTotal += s.siEmployee;
    // deductionsTotal là số ÂM (đã quy ước ở tầng lương)
    advanceTotal += Math.abs(s.deductionsTotal);

    // Chi phí = thu nhập + bảo hiểm phía DN, theo BỘ PHẬN.
    const erForSlip = s.siEmployer;
    accrual.push({
      account: expenseAccount(map, s.department),
      side: 'DEBIT',
      amount: s.earningsTotal + erForSlip,
      memo: `Lương + BH NSDLĐ ${s.employeeCode}`,
    });
  }

  // Đối ứng: phải trả người lao động và các khoản bảo hiểm phía DN.
  accrual.push({
    account: acc(map, 'payableSalary'),
    side: 'CREDIT',
    amount: grossTotal,
    memo: `Phải trả NLĐ kỳ ${periodTag}`,
  });
  accrual.push({
    account: acc(map, 'siSocial'),
    side: 'CREDIT',
    amount: erSi.social,
    memo: `BHXH phía DN kỳ ${periodTag}`,
  });
  accrual.push({
    account: acc(map, 'siHealth'),
    side: 'CREDIT',
    amount: erSi.health,
    memo: `BHYT phía DN kỳ ${periodTag}`,
  });
  accrual.push({
    account: acc(map, 'siUnemployment'),
    side: 'CREDIT',
    amount: erSi.unemployment,
    memo: `BHTN phía DN kỳ ${periodTag}`,
  });
  accrual.push({
    account: acc(map, 'siAccident'),
    side: 'CREDIT',
    amount: erSi.accident,
    memo: `Quỹ TNLĐ-BNN kỳ ${periodTag}`,
  });

  // --- 2. TRÍCH KHẤU TRỪ ---------------------------------------------------
  deduction.push({
    account: acc(map, 'payableSalary'),
    side: 'DEBIT',
    amount: eeSiTotal + pitTotal + advanceTotal,
    memo: `Trích khấu trừ kỳ ${periodTag}`,
  });
  deduction.push({
    account: acc(map, 'siSocial'),
    side: 'CREDIT',
    amount: eeSi.social,
    memo: `BHXH phần NLĐ kỳ ${periodTag}`,
  });
  deduction.push({
    account: acc(map, 'siHealth'),
    side: 'CREDIT',
    amount: eeSi.health,
    memo: `BHYT phần NLĐ kỳ ${periodTag}`,
  });
  deduction.push({
    account: acc(map, 'siUnemployment'),
    side: 'CREDIT',
    amount: eeSi.unemployment,
    memo: `BHTN phần NLĐ kỳ ${periodTag}`,
  });
  deduction.push({
    account: acc(map, 'pitPayable'),
    side: 'CREDIT',
    amount: pitTotal,
    memo: `Thuế TNCN kỳ ${periodTag}`,
  });
  deduction.push({
    account: map.advanceAccount,
    side: 'CREDIT',
    amount: advanceTotal,
    memo: `Thu hồi tạm ứng kỳ ${periodTag}`,
  });

  // --- 3. TRẢ LƯƠNG --------------------------------------------------------
  const payment: GlLine[] = [
    {
      account: acc(map, 'payableSalary'),
      side: 'DEBIT',
      amount: netTotal,
      memo: `Trả lương kỳ ${periodTag}`,
    },
    {
      account: acc(map, 'bankVnd'),
      side: 'CREDIT',
      amount: netTotal,
      memo: `Chi tiền gửi kỳ ${periodTag}`,
    },
  ];

  const built = [
    finalize(
      {
        ...meta,
        entryNo: `PR-${periodTag}-ACCRUAL`,
        entryType: 'SALARY_ACCRUAL',
        memo: `Ghi nhận chi phí lương kỳ ${periodTag}`,
      },
      accrual,
    ),
    finalize(
      {
        ...meta,
        entryNo: `PR-${periodTag}-DEDUCT`,
        entryType: 'SALARY_DEDUCTION',
        memo: `Trích các khoản khấu trừ kỳ ${periodTag}`,
      },
      deduction,
    ),
    finalize(
      {
        ...meta,
        entryNo: `PR-${periodTag}-PAY`,
        entryType: 'SALARY_PAYMENT',
        memo: `Trả lương qua ngân hàng kỳ ${periodTag}`,
      },
      payment,
    ),
  ];

  // BỎ QUA BÚT TOÁN KHÔNG ÁP DỤNG.
  //
  // Một kỳ lương mà không ai có khoản khấu trừ nào (không bảo hiểm, không thuế,
  // không tạm ứng) thì bút toán khấu trừ KHÔNG CÓ NỘI DUNG. Sinh ra nó sẽ để lại
  // một bút toán rỗng trong sổ cái — tệ hơn không có gì, vì nó nằm đó như thể đã
  // hạch toán một nghiệp vụ không tồn tại.
  //
  // Phân biệt rõ hai trường hợp:
  //   0 dòng                     → nghiệp vụ không phát sinh, bỏ qua bút toán.
  //   ≥1 dòng nhưng chỉ một bên  → DỮ LIỆU SAI, phải ném lỗi.
  // Kiểm tra cân đối chạy SAU khi lọc, nên trường hợp thứ hai vẫn bị bắt.
  const applicable = built.filter((e) => e.lines.length > 0);
  for (const e of applicable) assertBalanced(e);

  return applicable;
}

/**
 * Số dư từng tài khoản sau một loạt bút toán.
 *
 * Dùng để kiểm tra bất biến quan trọng nhất: sau khi ghi đủ ba bút toán, tài
 * khoản 334 phải BẰNG 0. Còn dư nghĩa là ghi thiếu hoặc ghi trùng.
 */
export function accountBalances(entries: GlEntry[]): Map<string, number> {
  const balances = new Map<string, number>();
  for (const e of entries) {
    for (const l of e.lines) {
      const delta = l.side === 'DEBIT' ? l.amount : -l.amount;
      balances.set(l.account, (balances.get(l.account) ?? 0) + delta);
    }
  }
  return balances;
}
