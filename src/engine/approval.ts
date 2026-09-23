/**
 * ============================================================================
 * ENGINE NGƯỠNG DUYỆT — "đơn này cần những ai duyệt?"
 * ============================================================================
 *
 *   resolveApprovalChain(input, params)   ← params từ policy_versions
 *
 * Trả về MỘT CHUỖI người duyệt theo thứ bậc, không phải một người. Lý do nằm
 * ở ghi chú đầu `approval-params.ts`: cách "chỉ người ở bậc khớp" tạo lỗ hổng
 * khi đơn lớn bỏ qua quản lý trực tiếp.
 *
 * KHÔNG có machine trạng thái ở đây. File này thuần tuý trả lời câu hỏi
 * "cần những ai"; còn "đã duyệt tới đâu" là việc của Phase 4.
 */

import type { ApprovalParams, ApprovalRule } from '../policy/approval-params.js';

export interface ApprovalRequest {
  /** Loại chứng từ, vd. 'LEAVE', 'EXPENSE'. */
  docType: string;
  /** Giá trị để so với ngưỡng — ngày, giờ, hoặc số tiền. Không được âm. */
  value: number;
}

export interface ApprovalChainStep {
  order: number;
  code: string;
  name: string;
  /** Bước này là bước được ngưỡng chỉ định (true) hay chỉ nằm trong chuỗi. */
  isMatched: boolean;
}

export interface ApprovalChainResult {
  docType: string;
  label: string;
  unit: string;
  value: number;
  /** Chuỗi duyệt, sắp theo thứ bậc tăng dần. */
  chain: ApprovalChainStep[];
  /** Ngưỡng đã khớp. null = bậc không giới hạn. */
  matchedUpto: number | null;
  /** Cấp duyệt do ngưỡng chỉ định. */
  matchedLevel: string;
}

/**
 * Tìm luật theo loại chứng từ.
 *
 * NÉM LỖI nếu không có — KHÔNG suy đoán, KHÔNG dùng luật đầu tiên. Một loại
 * chứng từ chưa cấu hình ngưỡng thì phải dừng lại và báo, vì "mặc định cho
 * quản lý trực tiếp duyệt" sẽ âm thầm bỏ qua kế toán trưởng với một đề nghị
 * thanh toán 500 triệu.
 */
export function findRule(params: ApprovalParams, docType: string): ApprovalRule {
  const rule = params.rules.find((r) => r.docType === docType);
  if (!rule) {
    const known = params.rules.map((r) => r.docType).join(', ');
    throw new RangeError(
      `Chế độ '${params.regimeCode}' chưa cấu hình ngưỡng duyệt cho loại '${docType}'. ` +
        `Các loại đã có: ${known || '(không có)'}.`,
    );
  }
  return rule;
}

export function resolveApprovalChain(
  input: ApprovalRequest,
  params: ApprovalParams,
): ApprovalChainResult {
  if (!Number.isFinite(input.value)) {
    throw new RangeError(
      `Giá trị duyệt không hữu hạn: ${input.value}. ` +
        `Một ô số liệu trống trên đơn sẽ sinh NaN và làm đơn khớp sai bậc.`,
    );
  }
  if (input.value < 0) {
    throw new RangeError(`Giá trị duyệt không được âm: ${input.value}`);
  }

  const rule = findRule(params, input.docType);

  // --- Tìm bậc khớp ---------------------------------------------------------
  // superRefine đã đảm bảo ngưỡng tăng dần và bậc cuối mở, nên có ĐÚNG MỘT
  // bậc khớp. Nếu vẫn không tìm thấy thì bộ tham số đã bị sửa thẳng vào DB
  // (bypass validate) — ném lỗi chứ không mặc định.
  let matchedIndex = -1;
  for (let i = 0; i < rule.thresholds.length; i++) {
    const t = rule.thresholds[i];
    if (!t) continue;
    if (t.upto === null || input.value < t.upto) {
      matchedIndex = i;
      break;
    }
  }
  const matched = rule.thresholds[matchedIndex];
  if (!matched) {
    throw new RangeError(
      `Không bậc ngưỡng nào khớp cho ${input.docType} = ${input.value} ${rule.unit}. ` +
        `Bậc cuối phải để trống ngưỡng (không giới hạn) — bộ tham số này có vẻ đã bị sửa ngoài giao diện.`,
    );
  }

  const matchedLevel = params.levels.find((l) => l.code === matched.level);
  if (!matchedLevel) {
    throw new RangeError(
      `Cấp duyệt '${matched.level}' của '${input.docType}' không tồn tại trong danh sách cấp.`,
    );
  }

  // --- Dựng chuỗi -----------------------------------------------------------
  // Chuỗi lấy từ CHÍNH CÁC BẬC CỦA LUẬT NÀY (từ bậc đầu tới bậc khớp), không
  // phải "mọi cấp có thứ bậc ≤ cấp khớp".
  //
  // Khác biệt này quan trọng: với EXPENSE có bậc DIRECT_MANAGER → DEPT_HEAD →
  // CHIEF_ACCOUNTANT → CEO, cách lọc theo order toàn cục sẽ kéo cả HR_HEAD
  // (thứ bậc 3) vào duyệt một đề nghị thanh toán, dù nhân sự không liên quan
  // gì tới chi tiền. Mỗi luật định nghĩa đường duyệt RIÊNG của nó; `order` chỉ
  // dùng để sắp xếp hiển thị.
  const seen = new Set<string>();
  const chain: ApprovalChainStep[] = [];
  for (let i = 0; i <= matchedIndex; i++) {
    const t = rule.thresholds[i];
    if (!t || seen.has(t.level)) continue;
    const level = params.levels.find((l) => l.code === t.level);
    if (!level) {
      throw new RangeError(
        `Cấp duyệt '${t.level}' của '${input.docType}' không tồn tại trong danh sách cấp.`,
      );
    }
    seen.add(t.level);
    chain.push({
      order: level.order,
      code: level.code,
      name: level.name,
      isMatched: i === matchedIndex,
    });
  }
  chain.sort((a, b) => a.order - b.order);

  if (chain.length === 0) {
    throw new RangeError(
      `Chuỗi duyệt rỗng cho ${input.docType} — luật này không trỏ tới cấp duyệt nào hợp lệ.`,
    );
  }

  return {
    docType: rule.docType,
    label: rule.label,
    unit: rule.unit,
    value: input.value,
    chain,
    matchedUpto: matched.upto,
    matchedLevel: matchedLevel.code,
  };
}
