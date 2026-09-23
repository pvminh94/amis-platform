/**
 * ============================================================================
 * ENGINE BẢO HIỂM XÃ HỘI — nhận tham số làm ĐẦU VÀO, giống engine thuế
 * ============================================================================
 *
 *   calculateSocialInsurance(input, params)   ← params từ policy_versions
 *
 * Không một con số nào trong file này là hằng số nghiệp vụ: tỷ lệ, mức tham
 * chiếu, hệ số trần, lương tối thiểu vùng đều đến từ `params`. Đổi luật = thêm
 * một dòng vào DB qua giao diện.
 *
 * BA ĐIỂM DỄ SAI MÀ FILE NÀY XỬ LÝ TƯỜNG MINH:
 *
 *  1. BHXH/BHYT và BHTN có HAI CƠ SỞ KHÁC NHAU. BHXH/BHYT kẹp theo mức tham
 *     chiếu (20×); BHTN kẹp theo LƯƠNG TỐI THIỂU VÙNG (20× vùng). Gộp chung
 *     một trần là lỗi phổ biến nhất và làm sai cả hai đầu.
 *
 *  2. Cộng 7% cho lao động đã qua đào tạo nghề áp vào SÀN BHTN — không phải
 *     trần, và không áp cho BHXH/BHYT.
 *
 *  3. Chạm trần hay chạm sàn phải ĐƯỢC GHI LẠI trong kết quả. Người lao động
 *     thấy số bị trừ "không đúng tỷ lệ" là vì lương họ vượt trần; nếu phiếu
 *     lương không nói ra thì đó là lỗi trình bày, không phải lỗi tính.
 */

import type { VnSiParams } from '../policy/si-params.js';
import { roundVnd, clampBase } from './money.js';

export type WageRegion = 'I' | 'II' | 'III' | 'IV';

export interface SiCalcInput {
  /**
   * Lương làm căn cứ đóng bảo hiểm (VND/tháng).
   *
   * Đây thường là lương theo hợp đồng, KHÔNG gồm tiền làm thêm giờ. Đưa cả OT
   * vào căn cứ là lỗi phổ biến làm tăng số phải đóng của cả hai bên.
   */
  contributionSalary: number;
  /** Vùng lương tối thiểu nơi người lao động làm việc. */
  wageRegion: WageRegion;
  /** Đã qua đào tạo nghề? Ảnh hưởng SÀN BHTN (+7%). Mặc định false. */
  trainedWorker?: boolean;
  /** Số tháng tính trong kỳ, trong (0, 1]. Mặc định 1. */
  monthsInPeriod?: number;
}

export interface SiSideBreakdown {
  socialInsurance: number;
  healthInsurance: number;
  unemployment: number;
  /** Quỹ TNLĐ-BNN — chỉ phía doanh nghiệp, hạch toán TK 3388. */
  accident: number;
  total: number;
}

export interface SiCalcResult {
  /** Căn cứ đóng BHXH/BHYT sau khi kẹp sàn/trần theo mức tham chiếu. */
  siBase: number;
  /** Căn cứ đóng BHTN sau khi kẹp sàn/trần theo lương tối thiểu vùng. */
  uiBase: number;

  siFloor: number;
  siCap: number;
  uiFloor: number;
  uiCap: number;

  /** Cờ để trình bày trên phiếu lương — xem ghi chú đầu file, điểm 3. */
  siHitFloor: boolean;
  siHitCap: boolean;
  uiHitFloor: boolean;
  uiHitCap: boolean;

  employee: SiSideBreakdown;
  employer: SiSideBreakdown;
}

/**
 * Lấy lương tối thiểu của một vùng.
 *
 * NÉM LỖI nếu vùng không có trong bộ tham số — KHÔNG suy đoán, KHÔNG lấy
 * vùng đầu tiên làm mặc định. Cùng triết lý với `resolvePolicy`: thiếu căn cứ
 * pháp lý thì dừng lại, vì tính ra một con số sai rồi ghi vào sổ sách thì tốn
 * kém hơn nhiều so với một thông báo lỗi.
 */
export function regionalMinimumWage(params: VnSiParams, region: WageRegion): number {
  const row = params.regionalMinimumWages.find((r) => r.region === region);
  if (!row) {
    const known = params.regionalMinimumWages.map((r) => r.region).join(', ');
    throw new RangeError(
      `Bộ tham số '${params.regimeCode}' không khai báo lương tối thiểu cho Vùng ${region}. ` +
        `Các vùng đã có: ${known || '(không có vùng nào)'}.`,
    );
  }
  return row.monthly;
}

export function calculateSocialInsurance(
  input: SiCalcInput,
  params: VnSiParams,
): SiCalcResult {
  const months = input.monthsInPeriod ?? 1;
  if (!Number.isFinite(months) || months <= 0 || months > 1) {
    throw new RangeError(`monthsInPeriod phải trong khoảng (0, 1], nhận: ${months}`);
  }
  if (!Number.isFinite(input.contributionSalary)) {
    throw new RangeError(
      `contributionSalary không hữu hạn: ${input.contributionSalary}. ` +
        `Một trường hồ sơ nhân sự bị thiếu sẽ sinh NaN, và NaN lan ra mọi khoản trích.`,
    );
  }
  if (input.contributionSalary < 0) {
    throw new RangeError(`contributionSalary không được âm: ${input.contributionSalary}`);
  }

  const regionMin = regionalMinimumWage(params, input.wageRegion);

  // --- Cơ sở BHXH/BHYT: kẹp theo MỨC THAM CHIẾU ----------------------------
  const siFloor = params.referenceSalary;
  const siCap = params.referenceSalary * params.siCapMultiplier;
  const si = clampBase(input.contributionSalary, siFloor, siCap);

  // --- Cơ sở BHTN: kẹp theo LƯƠNG TỐI THIỂU VÙNG ---------------------------
  const uplift = input.trainedWorker ? params.trainedWorkerUplift : 0;
  const uiFloor = regionMin * (1 + uplift);
  const uiCap = regionMin * params.uiCapMultiplier;
  const ui = clampBase(input.contributionSalary, uiFloor, uiCap);

  // --- Số tiền từng quỹ -----------------------------------------------------
  // Căn cứ là mức THÁNG, đã bị kẹp. Kỳ ngắn hơn một tháng thì nhân tỷ lệ —
  // kẹp theo tháng rồi mới nhân, không nhân rồi mới kẹp: kẹp sau khi nhân sẽ
  // cho phép một kỳ nửa tháng vượt trần tháng.
  const amt = (base: number, rate: number) => roundVnd(base * rate * months);

  const employee = {
    socialInsurance: amt(si.base, params.employee.socialInsurance),
    healthInsurance: amt(si.base, params.employee.healthInsurance),
    unemployment: amt(ui.base, params.employee.unemployment),
    accident: 0,
    total: 0,
  };
  employee.total =
    employee.socialInsurance + employee.healthInsurance + employee.unemployment;

  const employer = {
    socialInsurance: amt(si.base, params.employer.socialInsurance),
    healthInsurance: amt(si.base, params.employer.healthInsurance),
    unemployment: amt(ui.base, params.employer.unemployment),
    accident: amt(si.base, params.employer.accident),
    total: 0,
  };
  employer.total =
    employer.socialInsurance +
    employer.healthInsurance +
    employer.unemployment +
    employer.accident;

  return {
    siBase: roundVnd(si.base),
    uiBase: roundVnd(ui.base),
    siFloor: roundVnd(siFloor),
    siCap: roundVnd(siCap),
    uiFloor: roundVnd(uiFloor),
    uiCap: roundVnd(uiCap),
    siHitFloor: si.hitFloor,
    siHitCap: si.hitCap,
    uiHitFloor: ui.hitFloor,
    uiHitCap: ui.hitCap,
    employee,
    employer,
  };
}
