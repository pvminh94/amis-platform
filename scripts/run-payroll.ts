/**
 * ============================================================================
 * SEED NHÂN VIÊN + TÍNH MỘT KỲ LƯƠNG THẬT
 * ============================================================================
 *
 * Chạy: npm run payroll
 *
 * Idempotent: xoá kỳ cũ rồi tính lại, nên chạy bao nhiêu lần cũng cho cùng kết
 * quả. Script chỉ chạy được một lần thì không phải demo, là bẫy.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { employees, payslips, payRuns } = await import('../src/db/schema.js');
const { generatePayRun, assertPayRunConsistent, standardWorkingDays } = await import(
  '../src/lib/payroll.js'
);
const { eq, sql } = await import('drizzle-orm');

const db = getDb();
const fmt = (n: number) => n.toLocaleString('vi-VN');

const ROSTER = [
  { employeeCode: 'NV001', fullName: 'Nguyễn Văn An', department: 'Kỹ thuật', wageRegion: 'I', trainedWorker: true, dependents: 1, baseSalary: 25_000_000, hourlyRate: 120_000 },
  { employeeCode: 'NV002', fullName: 'Trần Thị Bình', department: 'Kỹ thuật', wageRegion: 'I', trainedWorker: true, dependents: 2, baseSalary: 32_000_000, hourlyRate: 155_000 },
  { employeeCode: 'NV003', fullName: 'Lê Văn Cường', department: 'Kinh doanh', wageRegion: 'I', trainedWorker: false, dependents: 0, baseSalary: 18_000_000, hourlyRate: 87_000 },
  { employeeCode: 'NV004', fullName: 'Phạm Thị Dung', department: 'Kinh doanh', wageRegion: 'II', trainedWorker: true, dependents: 3, baseSalary: 22_000_000, hourlyRate: 106_000 },
  { employeeCode: 'NV005', fullName: 'Hoàng Văn Em', department: 'Nhân sự', wageRegion: 'I', trainedWorker: true, dependents: 1, baseSalary: 28_000_000, hourlyRate: 135_000 },
  { employeeCode: 'NV006', fullName: 'Vũ Thị Giang', department: 'Kế toán', wageRegion: 'I', trainedWorker: true, dependents: 2, baseSalary: 26_000_000, hourlyRate: 125_000 },
  { employeeCode: 'NV007', fullName: 'Đặng Văn Hải', department: 'Sản xuất', wageRegion: 'III', trainedWorker: false, dependents: 4, baseSalary: 12_000_000, hourlyRate: 58_000 },
  { employeeCode: 'NV008', fullName: 'Bùi Thị Hoa', department: 'Sản xuất', wageRegion: 'III', trainedWorker: true, dependents: 1, baseSalary: 14_500_000, hourlyRate: 70_000 },
  { employeeCode: 'NV009', fullName: 'Đỗ Văn Inh', department: 'Sản xuất', wageRegion: 'IV', trainedWorker: false, dependents: 0, baseSalary: 9_000_000, hourlyRate: 43_000 },
  { employeeCode: 'NV010', fullName: 'Ngô Thị Kim', department: 'Kỹ thuật', wageRegion: 'I', trainedWorker: true, dependents: 0, baseSalary: 45_000_000, hourlyRate: 216_000 },
  { employeeCode: 'NV011', fullName: 'Lý Văn Long', department: 'Kinh doanh', wageRegion: 'II', trainedWorker: false, dependents: 2, baseSalary: 16_000_000, hourlyRate: 77_000 },
  { employeeCode: 'NV012', fullName: 'Trịnh Thị Mai', department: 'Nhân sự', wageRegion: 'IV', trainedWorker: true, dependents: 1, baseSalary: 11_000_000, hourlyRate: 53_000 },
] as const;

console.log('\n' + '═'.repeat(78));
console.log('  TÍNH LƯƠNG HÀNG LOẠT — employee thật, chính sách từ database');
console.log('═'.repeat(78) + '\n');

// --- 1. Nhân viên ---------------------------------------------------------
await db.execute(sql`DELETE FROM payslips`);
await db.execute(sql`DELETE FROM pay_runs`);
await db.execute(sql`DELETE FROM employees`);
for (const e of ROSTER) {
  await db.insert(employees).values({ ...e, active: true });
}
console.log(`[1] ✓ Đã nạp ${ROSTER.length} nhân viên (4 vùng lương, 6 bộ phận)`);

// --- 2. Tính kỳ lương -----------------------------------------------------
const YEAR = 2026;
const MONTH = 9;
const std = standardWorkingDays(YEAR, MONTH);
console.log(`[2] Kỳ ${String(MONTH).padStart(2, '0')}/${YEAR} — ${std} ngày công chuẩn (thứ Hai→thứ Bảy)\n`);

// Vài nhân viên có chấm công riêng, còn lại dùng mặc định
const attendance = {
  NV001: { workedDays: 22, kpiScore: 85, otNormalHours: 10, otWeekendHours: 4, lateCount: 5, advanceAmount: 2_000_000 },
  NV002: { workedDays: std, kpiScore: 95, otNormalHours: 20, otWeekendHours: 8, otHolidayHours: 0 },
  NV003: { workedDays: std, kpiScore: 60, otNormalHours: 0, lateCount: 8 },
  NV010: { workedDays: std, kpiScore: 100, otNormalHours: 30, otWeekendHours: 16, otHolidayHours: 8 },
  NV009: { workedDays: 15, kpiScore: 70 },
};

const result = await generatePayRun({ periodYear: YEAR, periodMonth: MONTH, attendance, actor: 'payroll-admin' });

console.log('    Chính sách đã áp dụng:');
console.log(`      công thức lương : ${result.applied.salary}`);
console.log(`      bảo hiểm        : ${result.applied.si}`);
console.log(`      thuế TNCN       : ${result.applied.pit}\n`);

console.log(`    ${'Mã'.padEnd(7)}${'Họ tên'.padEnd(20)}${'Vùng'.padEnd(6)}${'Thu nhập'.padStart(14)}${'BH NLĐ'.padStart(12)}${'Thuế'.padStart(12)}${'Thực nhận'.padStart(14)}`);
console.log('    ' + '─'.repeat(83));

const slips = await db
  .select({ s: payslips, region: employees.wageRegion })
  .from(payslips)
  .innerJoin(employees, eq(payslips.employeeId, employees.id))
  .where(eq(payslips.payRunId, result.payRunId));
for (const row of slips) {
  const s = row.s;
  console.log(
    '    ' + s.employeeCode.padEnd(7) + s.fullName.padEnd(20) +
    row.region.padEnd(6) + fmt(s.earningsTotal).padStart(14) +
    fmt(s.siEmployee).padStart(12) + fmt(s.pit).padStart(12) + fmt(s.netPay).padStart(14),
  );
}
console.log('    ' + '─'.repeat(83));
console.log(
  '    ' + 'TỔNG'.padEnd(7) + `${result.count} phiếu`.padEnd(20) + ' '.repeat(6) +
  fmt(result.totals.gross).padStart(14) + fmt(result.totals.siEmployee).padStart(12) +
  fmt(result.totals.pit).padStart(12) + fmt(result.totals.net).padStart(14),
);

console.log(`\n    Chi phí bảo hiểm phía doanh nghiệp: ${fmt(result.totals.siEmployer)}`);
console.log(`    Tổng chi phí kỳ lương            : ${fmt(result.totals.gross + result.totals.siEmployer)}`);

// --- 3. Đối chiếu ---------------------------------------------------------
await assertPayRunConsistent(result.payRunId);
console.log('\n[3] ✓ Đối chiếu: tổng trên kỳ = tổng các phiếu (cả 4 chỉ tiêu)');

// --- 4. Thử tính lại phải bị chặn -----------------------------------------
try {
  await generatePayRun({ periodYear: YEAR, periodMonth: MONTH });
  console.log('[4] ✗ LỖI: tính lại kỳ đã có mà không bị chặn');
} catch (e) {
  console.log(`[4] ✓ Tính lại kỳ đã có bị chặn: ${(e as Error).message.slice(0, 60)}…`);
}

console.log('\n    Xem phiếu lương tại /payroll và /payroll/[payRunId]\n');
await closeDb();
