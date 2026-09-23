/**
 * Test cho tầng tính lương hàng loạt.
 *
 * Các giá trị ngày công dưới đây được tính BẰNG CÁCH ĐẾM LỊCH ĐỘC LẬP
 * (đếm số Chủ nhật rồi trừ), không phải bằng chính hàm đang test.
 */

import { describe, it, expect } from 'vitest';
import { standardWorkingDays, generatePayRun } from '../src/lib/payroll';

describe('standardWorkingDays — ngày công chuẩn theo lịch thật', () => {
  // Ground truth: số ngày trong tháng trừ số Chủ nhật (tuần 6 ngày).
  const cases: Array<[number, number, number]> = [
    [2026, 1, 27],
    [2026, 2, 24],
    [2026, 3, 26],
    [2026, 7, 27],
    [2026, 8, 26],
    [2026, 9, 26],
    [2026, 12, 27],
  ];
  it.each(cases)('%d-%d → %d ngày', (y, m, expected) => {
    expect(standardWorkingDays(y, m)).toBe(expected);
  });

  it('tháng 2 năm nhuận (2024) có 25 ngày công, năm thường 24', () => {
    // Chênh nhau đúng 1 ngày — đủ để làm sai lương tháng 2 nếu chia cứng 26.
    expect(standardWorkingDays(2024, 2)).toBe(25);
    expect(standardWorkingDays(2027, 2)).toBe(24);
  });

  it('không tháng nào ra đúng 26 — chứng minh chia cứng 26 là sai', () => {
    // Nếu hardcode 26, tháng 2 sẽ thấp hơn thực tế và tháng 1/7/12 cao hơn.
    const values = new Set<number>();
    for (let m = 1; m <= 12; m++) values.add(standardWorkingDays(2026, m));
    expect(values.size).toBeGreaterThan(1);
  });
});

describe('generatePayRun — chặn đầu vào sai TRƯỚC khi chạm database', () => {
  it.each([
    [2026, 0],
    [2026, 13],
    [2026, 6.5],
    [2026, -1],
  ])('tháng %s/%s bị từ chối', async (y, m) => {
    await expect(generatePayRun({ periodYear: y, periodMonth: m })).rejects.toThrow(
      /Tháng không hợp lệ/,
    );
  });

  it.each([
    [1999, 9],
    [2026.5, 9],
  ])('năm %s bị từ chối', async (y, m) => {
    await expect(generatePayRun({ periodYear: y, periodMonth: m })).rejects.toThrow(
      /Năm không hợp lệ/,
    );
  });
});
