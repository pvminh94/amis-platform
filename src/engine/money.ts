/**
 * ============================================================================
 * TIỀN TỆ — một chỗ duy nhất cho quy ước làm tròn VND
 * ============================================================================
 *
 * Tách ra khỏi engine thuế vì engine bảo hiểm cũng cần đúng quy ước này. Nếu
 * hai engine tự làm tròn theo hai kiểu thì một phiếu lương sẽ có tổng các
 * khoản trích không bằng đúng số đã ghi — và kế toán sẽ phát hiện ra trước
 * khi ta kịp phát hiện.
 */

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

/**
 * Ép một giá trị vào khoảng [floor, cap].
 *
 * Trả về cả CỜ đã chạm sàn/trần hay chưa, vì đó là thông tin bắt buộc phải có
 * trên phiếu lương: người lao động phải thấy được lương mình bị chặn ở trần
 * bảo hiểm, nếu không họ sẽ tự tính và thấy số bị trừ "sai".
 */
export function clampBase(
  value: number,
  floor: number,
  cap: number,
): { base: number; hitFloor: boolean; hitCap: boolean } {
  for (const [name, v] of [
    ['value', value],
    ['floor', floor],
    ['cap', cap],
  ] as const) {
    if (!Number.isFinite(v)) {
      throw new RangeError(`clampBase: ${name} không hữu hạn (${v})`);
    }
  }
  if (cap < floor) {
    throw new RangeError(
      `clampBase: trần (${cap}) nhỏ hơn sàn (${floor}). ` +
        `Bộ tham số bảo hiểm trong DB bị nhập sai — dừng lại chứ không tính bừa.`,
    );
  }
  if (value <= floor) return { base: floor, hitFloor: true, hitCap: false };
  if (value >= cap) return { base: cap, hitFloor: false, hitCap: true };
  return { base: value, hitFloor: false, hitCap: false };
}
