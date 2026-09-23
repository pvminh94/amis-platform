/**
 * ============================================================================
 * ENGINE LƯƠNG — tính từng thành phần theo CÔNG THỨC trong database
 * ============================================================================
 *
 *   calculateSalary(input, params)   ← params từ policy_versions
 *
 * Không một thành phần lương nào được hardcode. Công thức nằm trong DB, HR sửa
 * qua giao diện, engine chỉ việc chạy.
 *
 * BA QUYẾT ĐỊNH ĐÁNG CHÚ Ý:
 *
 *  1. `onMissingVar: 'throw'` — BẮT BUỘC. Mặc định của evaluator là 'zero',
 *     tiện cho máy tính bỏ túi nhưng chết người ở đây: một biến gõ sai sẽ trả
 *     về 0, nhân viên nhận lương thiếu, và không có dòng log nào. Thà dừng cả
 *     kỳ lương còn hơn trả sai 500 người.
 *
 *  2. Thành phần tính theo `sequence` tăng dần, và kết quả của thành phần
 *     trước được đưa vào ngữ cảnh làm biến cho thành phần sau. superRefine đã
 *     chặn tham chiếu ngược lúc LƯU, nên ở đây không thể có vòng lặp.
 *
 *  3. KHÔNG nhân tỷ lệ theo số tháng trong kỳ. Kỳ vào/ra giữa tháng được xử lý
 *     bằng `workedDays / standardDays` NGAY TRONG CÔNG THỨC. Nếu engine nhân
 *     thêm một lần nữa thì sẽ trừ hai lần — và vì công thức do người dùng tự
 *     viết, engine không có cách nào biết họ đã chia ngày công hay chưa.
 */

import type { VnSalaryParams, SalaryComponent } from '../policy/salary-params.js';
import { evalFormula, FormulaError, type FormulaContext } from './formula.js';
import { roundVnd } from './money.js';

export interface SalaryInput {
  /**
   * Giá trị các biến đầu vào. PHẢI cung cấp đủ mọi biến khai báo trong
   * `params.inputVariables` — thiếu một biến là ném lỗi, không suy ra 0.
   */
  variables: Record<string, number>;
}

export interface SalaryComponentResult {
  code: string;
  label: string;
  formula: string;
  sequence: number;
  /** Số tiền đã làm tròn về đồng (VND). Có thể âm nếu là khoản khấu trừ. */
  amount: number;
  taxable: boolean;
  inInsuranceBase: boolean;
}

export interface SalaryResult {
  /** Kết quả từng thành phần, theo đúng thứ tự đã tính. */
  components: SalaryComponentResult[];
  /** Tổng các khoản DƯƠNG (thu nhập). */
  earningsTotal: number;
  /** Tổng các khoản ÂM (khấu trừ). Luôn ≤ 0. */
  deductionsTotal: number;
  /** Thu nhập ròng từ các thành phần = earnings + deductions. */
  netFromComponents: number;
  /** Tổng các thành phần có cờ `taxable` — đầu vào cho engine thuế TNCN. */
  taxableIncome: number;
  /** Tổng các thành phần có cờ `inInsuranceBase` — đầu vào cho engine BHXH. */
  insuranceBaseSalary: number;
}

export function calculateSalary(input: SalaryInput, params: VnSalaryParams): SalaryResult {
  // --- 1. Ngữ cảnh ban đầu: biến đầu vào ----------------------------------
  // Object.create(null): ngữ cảnh KHÔNG có prototype. Lớp phòng thủ thứ hai
  // sau hasOwnProperty trong evaluator — nếu có chỗ nào dùng `in` hay truy cập
  // trực tiếp thì 'constructor'/'__proto__' vẫn không tồn tại.
  const ctx: FormulaContext = Object.create(null) as FormulaContext;
  for (const name of params.inputVariables) {
    const v = input.variables[name];
    if (v === undefined) {
      throw new RangeError(
        `Thiếu biến đầu vào '${name}' cho chế độ lương '${params.regimeCode}'. ` +
          `Các biến bắt buộc: ${params.inputVariables.join(', ')}. ` +
          `Không tự suy ra 0 — một biến thiếu sẽ làm cả thành phần lương sai.`,
      );
    }
    if (!Number.isFinite(v)) {
      throw new RangeError(`Biến đầu vào '${name}' không hữu hạn: ${v}`);
    }
    ctx[name] = v;
  }

  // --- 2. Tính lần lượt theo sequence --------------------------------------
  const ordered = [...params.components].sort((a, b) => a.sequence - b.sequence);
  const results: SalaryComponentResult[] = [];

  for (const c of ordered) {
    const amount = evalComponent(c, ctx, params.regimeCode);
    ctx[c.code] = amount; // thành phần trước thành biến cho thành phần sau
    results.push({
      code: c.code,
      label: c.label,
      formula: c.formula,
      sequence: c.sequence,
      amount,
      taxable: c.taxable,
      inInsuranceBase: c.inInsuranceBase,
    });
  }

  // --- 3. Tổng hợp ----------------------------------------------------------
  let earningsTotal = 0;
  let deductionsTotal = 0;
  let taxableIncome = 0;
  let insuranceBaseSalary = 0;

  for (const r of results) {
    if (r.amount >= 0) earningsTotal += r.amount;
    else deductionsTotal += r.amount;
    // Khoản khấu trừ không làm giảm thu nhập CHỊU THUẾ (đó là tạm ứng, không
    // phải khoản giảm trừ theo luật). Thuế tính trên phần thu nhập, rồi tạm ứng
    // mới trừ vào lương thực nhận.
    if (r.taxable && r.amount > 0) taxableIncome += r.amount;
    if (r.inInsuranceBase && r.amount > 0) insuranceBaseSalary += r.amount;
  }

  return {
    components: results,
    earningsTotal: roundVnd(earningsTotal),
    deductionsTotal: roundVnd(deductionsTotal),
    netFromComponents: roundVnd(earningsTotal + deductionsTotal),
    taxableIncome: roundVnd(taxableIncome),
    insuranceBaseSalary: roundVnd(insuranceBaseSalary),
  };
}

/**
 * Tính một thành phần và kiểm tra kết quả.
 *
 * Ném lỗi nếu công thức ra âm mà thành phần không cho phép âm: một khoản thu
 * nhập âm nghĩa là công thức sai (vd. chia nhầm), và nếu âm thầm kẹp về 0 thì
 * phiếu lương sẽ sai mà không ai phát hiện.
 */
function evalComponent(
  c: SalaryComponent,
  ctx: FormulaContext,
  regimeCode: string,
): number {
  let raw: number;
  try {
    raw = evalFormula(c.formula, ctx, { onMissingVar: 'throw', onDivisionByZero: 'throw' });
  } catch (e) {
    const why = e instanceof FormulaError ? e.message : String(e);
    throw new RangeError(
      `Thành phần '${c.code}' của chế độ '${regimeCode}' không tính được: ${why}. ` +
        `Công thức: ${c.formula}`,
    );
  }
  if (!Number.isFinite(raw)) {
    throw new RangeError(
      `Thành phần '${c.code}' ra giá trị không hữu hạn (${raw}). ` +
        `Thường do chia cho 0 — kiểm tra mẫu số (vd. standardDays).`,
    );
  }
  const amount = roundVnd(raw);
  if (amount < 0 && !c.allowNegative) {
    throw new RangeError(
      `Thành phần '${c.code}' ra số âm (${amount.toLocaleString('vi-VN')}đ) nhưng không bật ` +
        `"cho phép âm". Đây là dấu hiệu công thức sai, không phải một khoản khấu trừ. ` +
        `Công thức: ${c.formula}`,
    );
  }
  return amount;
}
