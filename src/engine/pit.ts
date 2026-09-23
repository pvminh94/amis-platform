/**
 * ============================================================================
 * ENGINE THUẾ TNCN LUỸ TIẾN — nhận tham số làm ĐẦU VÀO
 * ============================================================================
 *
 * ĐIỂM MẤU CHỐT CỦA TOÀN BỘ KIẾN TRÚC:
 *
 *   function calculatePit(taxableIncome, params)   ← params truyền vào
 *   KHÔNG PHẢI
 *   function calculatePit(taxableIncome)           ← đọc hằng số trong file
 *
 * Mọi con số (bậc thuế, thuế suất, mức giảm trừ) đều đến từ `params`, mà
 * `params` đến từ policy_versions trong database. Đổi luật = thêm một dòng
 * vào DB qua giao diện. Không sửa file này, không build, không deploy.
 *
 * HAI CÁCH TÍNH, LUÔN ĐỐI CHIẾU NHAU:
 * Cơ quan thuế VN cho phép tính tắt bằng "số trừ nhanh". Nhưng cách tính
 * từng phần và cách tính tắt phải cho KẾT QUẢ GIỐNG NHAU. Hàm này tính cả
 * hai và so sánh. Nếu lệch → có nghĩa là bộ tham số trong DB bị nhập sai
 * (số trừ nhanh gõ tay lệch). Bắt ngay tại đây, không để lọt ra phiếu lương.
 */

import type { VnPitParams } from '../policy/tax-params.js';

/** Làm tròn nửa lên theo đồng — quy ước tiền tệ VN, không dùng float. */
export function roundVnd(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(
      `roundVnd nhận giá trị không hữu hạn: ${value}. ` +
        `Tiền tệ không được phép là NaN hay Infinity.`,
    );
  }
  return Math.sign(value) * Math.round(Math.abs(value) + Number.EPSILON);
}

export interface ProgressivePitResult {
  /** Số thuế phải nộp (VND). */
  pit: number;
  /** Thu nhập tính thuế sau giảm trừ (VND). */
  taxableIncome: number;
  /** Chỉ số bậc thuế áp dụng (0-based), để giải trình trên phiếu lương. */
  bracketIndex: number;
  /** Thuế tính theo công thức tắt — dùng để đối chiếu. */
  pitByQuickFormula: number;
  /** Hai cách tính có khớp nhau không (sai lệch ≤ 1đ do làm tròn). */
  quickFormulaMatch: boolean;
}

/**
 * Tính thuế luỹ tiến từng phần.
 *
 * @param taxableIncome Thu nhập tính thuế (sau khi trừ BHXH, giảm trừ gia cảnh…)
 * @param params        Bộ tham số thuế — bắt buộc truyền vào, không đọc hằng số
 */
export function calculateProgressivePit(
  taxableIncome: number,
  params: VnPitParams,
): ProgressivePitResult {
  if (!Number.isFinite(taxableIncome)) {
    throw new RangeError(
      `Thu nhập tính thuế không hữu hạn: ${taxableIncome}. ` +
        `Một trường chấm công/lương bị thiếu sẽ sinh NaN, và roundVnd(NaN) = 0 — ` +
        `nghĩa là trả lương 0đ mà không có dòng log nào. Phải ném lỗi.`,
    );
  }

  const { brackets } = params;
  if (brackets.length === 0) {
    throw new RangeError('Biểu thuế rỗng — không thể tính thuế');
  }

  // Thu nhập ≤ 0 thì không phải nộp thuế. Đây không phải "trường hợp đặc biệt"
  // cần bỏ qua: người lao động nghỉ không lương nhiều ngày là chuyện bình thường.
  if (taxableIncome <= 0) {
    return {
      pit: 0,
      taxableIncome: 0,
      bracketIndex: 0,
      pitByQuickFormula: 0,
      quickFormulaMatch: true,
    };
  }

  // --- CÁCH 1: tính từng phần (chuẩn, dùng làm kết quả chính) --------------
  let tax = 0;
  let lower = 0;
  let bracketIndex = brackets.length - 1;

  for (let i = 0; i < brackets.length; i++) {
    const b = brackets[i]!;
    const upper = b.upto === null ? Number.POSITIVE_INFINITY : b.upto;

    if (taxableIncome > upper) {
      // Thu nhập vượt bậc này → tính trọn phần trong bậc, sang bậc kế
      tax += (upper - lower) * b.rate;
      lower = upper;
      continue;
    }

    // Thu nhập rơi vào bậc này → tính phần còn lại rồi dừng
    tax += (taxableIncome - lower) * b.rate;
    bracketIndex = i;
    break;
  }

  const pit = roundVnd(tax);

  // --- CÁCH 2: công thức tắt (đối chiếu) -----------------------------------
  //   thuế = TNTT × thuế suất bậc áp dụng − số trừ nhanh bậc đó
  const applied = brackets[bracketIndex]!;
  const pitByQuickFormula = roundVnd(
    taxableIncome * applied.rate - applied.quickDeduction,
  );

  return {
    pit,
    taxableIncome: roundVnd(taxableIncome),
    bracketIndex,
    pitByQuickFormula,
    quickFormulaMatch: Math.abs(pit - pitByQuickFormula) <= 1,
  };
}

// ---------------------------------------------------------------------------
// TÍNH THU NHẬP TÍNH THUẾ TỪ LƯƠNG GROSS
// ---------------------------------------------------------------------------

export interface TaxableIncomeInput {
  /** Tổng thu nhập chịu thuế trong kỳ (VND). */
  grossIncome: number;
  /** Các khoản được MIỄN thuế đã tách riêng (phần OT vượt 100%, ăn ca vượt trần…). */
  exemptIncome: number;
  /** BHXH + BHYT + BHTN phần người lao động trích từ lương (VND). */
  employeeSocialInsurance: number;
  /** Bảo hiểm hưu trí tự nguyện đã đóng (VND), bị chặn theo trần tháng. */
  voluntaryPensionContribution: number;
  /** Số người phụ thuộc đã đăng ký hợp lệ. */
  dependentCount: number;
  /** Số tháng tính trong kỳ (thường 1; kỳ vào/ra giữa chừng có thể < 1). */
  monthsInPeriod?: number;
}

export interface TaxableIncomeResult {
  /** Tổng thu nhập chịu thuế. */
  assessableIncome: number;
  /** Trừ BHXH bắt buộc. */
  socialInsuranceDeduction: number;
  /** Trừ hưu trí tự nguyện (đã chặn trần). */
  voluntaryPensionDeduction: number;
  /** Giảm trừ bản thân. */
  selfDeduction: number;
  /** Giảm trừ người phụ thuộc. */
  dependentDeduction: number;
  /** Tổng các khoản giảm trừ. */
  totalDeductions: number;
  /** Thu nhập tính thuế = chịu thuế − tổng giảm trừ (không âm). */
  taxableIncome: number;
}

/**
 * Giảm trừ gia cảnh KHÔNG được chia nhỏ theo tỷ lệ ngày công.
 *
 * Đây là điểm dễ sai: người vào làm giữa tháng vẫn được trừ ĐỦ 15,5 triệu,
 * không phải 15,5 × (số ngày công / 26). Chia nhỏ theo ngày là sai luật và
 * làm người lao động nộp thuế oan. Thông tư 111/2013 quy định rõ giảm trừ
 * tính theo tháng.
 */
export function calculateTaxableIncome(
  input: TaxableIncomeInput,
  params: VnPitParams,
): TaxableIncomeResult {
  const months = input.monthsInPeriod ?? 1;
  if (!Number.isFinite(months) || months <= 0 || months > 1) {
    throw new RangeError(
      `monthsInPeriod phải trong khoảng (0, 1], nhận: ${months}`,
    );
  }

  for (const [name, value] of Object.entries({
    grossIncome: input.grossIncome,
    exemptIncome: input.exemptIncome,
    employeeSocialInsurance: input.employeeSocialInsurance,
    voluntaryPensionContribution: input.voluntaryPensionContribution,
  })) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${name} không hữu hạn: ${value}`);
    }
    if (value < 0) {
      throw new RangeError(`${name} không được âm: ${value}`);
    }
  }

  if (!Number.isInteger(input.dependentCount) || input.dependentCount < 0) {
    throw new RangeError(
      `dependentCount phải là số nguyên không âm, nhận: ${input.dependentCount}`,
    );
  }

  const assessableIncome = input.grossIncome - input.exemptIncome;

  // Hưu trí tự nguyện bị chặn trần theo tháng
  const voluntaryPensionDeduction = Math.min(
    input.voluntaryPensionContribution,
    params.voluntaryPensionCapMonthly * months,
  );

  const selfDeduction = roundVnd(params.selfDeduction * months);
  const dependentDeduction = roundVnd(
    params.dependentDeduction * input.dependentCount * months,
  );

  const totalDeductions =
    input.employeeSocialInsurance +
    voluntaryPensionDeduction +
    selfDeduction +
    dependentDeduction;

  const taxableIncome = Math.max(0, assessableIncome - totalDeductions);

  return {
    assessableIncome: roundVnd(assessableIncome),
    socialInsuranceDeduction: roundVnd(input.employeeSocialInsurance),
    voluntaryPensionDeduction: roundVnd(voluntaryPensionDeduction),
    selfDeduction,
    dependentDeduction,
    totalDeductions: roundVnd(totalDeductions),
    taxableIncome: roundVnd(taxableIncome),
  };
}
