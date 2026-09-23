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
const { aggregateAttendanceForPayroll } = await import('../src/lib/attendance.js');

const db = getDb();
const fmt = (n: number) => n.toLocaleString('vi-VN');

const { ROSTER, OTHER } = await import('./roster.js');

console.log('\n' + '═'.repeat(78));
console.log('  TÍNH LƯƠNG HÀNG LOẠT — employee thật, chính sách từ database');
console.log('═'.repeat(78) + '\n');

// --- 1. Nhân viên ---------------------------------------------------------
await db.execute(sql`DELETE FROM payslips`);
await db.execute(sql`DELETE FROM pay_runs`);
// KHÔNG xoá employees nữa.
//
// Bản trước có `DELETE FROM employees` rồi insert lại. Giờ `raw_punches` trỏ vào
// employees bằng khoá ngoại ON DELETE RESTRICT nên lệnh đó sẽ NỔ — và RESTRICT ở
// đây là cố ý: xoá một nhân viên không được kéo theo bằng chứng chấm công của họ.
// Nên chuyển sang UPSERT: dữ liệu chấm công sống sót qua mỗi lần chạy lại.
for (const e of ROSTER) {
  await db
    .insert(employees)
    .values({ ...e, active: true })
    .onConflictDoUpdate({
      target: employees.employeeCode,
      set: {
        fullName: e.fullName,
        department: e.department,
        wageRegion: e.wageRegion,
        trainedWorker: e.trainedWorker,
        dependents: e.dependents,
        baseSalary: e.baseSalary,
        hourlyRate: e.hourlyRate,
        active: true,
      },
    });
}
console.log(`[1] ✓ Đã nạp ${ROSTER.length} nhân viên (4 vùng lương, 6 bộ phận)`);

// --- 2. Tính kỳ lương -----------------------------------------------------
const YEAR = 2026;
const MONTH = 9;
const std = standardWorkingDays(YEAR, MONTH);
console.log(`[2] Kỳ ${String(MONTH).padStart(2, '0')}/${YEAR} — ${std} ngày công chuẩn (thứ Hai→thứ Bảy)\n`);

// --- Chấm công đọc TỪ DATABASE, không phải số gõ tay -----------------------
//
// Bản trước có một map { NV001: { workedDays: 22, otNormalHours: 10, … } } viết
// cứng trong file. Đó chính là "mock trong bộ nhớ" — bảng lương chạy ra số đẹp
// nhưng không liên quan gì tới quẹt thẻ. Nay đọc từ daily_attendance.
const attVars = await aggregateAttendanceForPayroll(db, { periodYear: YEAR, periodMonth: MONTH });
const covered = ROSTER.filter((e) => attVars[e.employeeCode]).length;

// DỪNG, không cảnh báo rồi đi tiếp.
//
// Bản trước chỉ in một dòng "[!] CHƯA CÓ CHẤM CÔNG … mọi người sẽ được tính đủ
// N ngày công theo mặc định" rồi TÍNH TIẾP. Kết quả: một kỳ lương không có một
// dòng chấm công nào vẫn chạy ra bảng lương trông hoàn toàn bình thường — trả
// đủ lương cho những ngày không ai chứng minh là đã làm. Và vì script exit 0,
// một chuỗi seed sai thứ tự (payroll chạy trước seed:attendance) không ai phát
// hiện: số vẫn đẹp, chỉ là sai.
//
// Kỳ không có chấm công nghĩa là HOẶC chưa import dữ liệu HOẶC cả công ty nghỉ —
// cả hai đều cần người quyết, không phải một giá trị mặc định.
if (covered === 0 && process.env.ALLOW_NO_ATTENDANCE !== 'true') {
  console.error(
    `\n✗ KHÔNG CÓ CHẤM CÔNG cho kỳ ${MONTH}/${YEAR} — từ chối tính lương.\n` +
      `  Kỳ không có chấm công là HOẶC chưa import dữ liệu HOẶC cả công ty nghỉ;\n` +
      `  cả hai đều cần người quyết. Chạy 'npm run seed:attendance' trước.\n` +
      `  Nếu thật sự muốn trả đủ ${std} ngày công mà không cần bằng chứng:\n` +
      `      ALLOW_NO_ATTENDANCE=true npm run payroll\n`,
  );
  await closeDb();
  process.exit(1);
}
console.log(
  `[2] ${covered === 0 ? '⚠' : '✓'} Chấm công: ${covered}/${ROSTER.length} nhân viên có dữ liệu kỳ ${MONTH}/${YEAR}` +
    (covered === 0 ? '  (ALLOW_NO_ATTENDANCE=true — tính đủ ngày công, KHÔNG có bằng chứng)' : ''),
);
if (covered > 0 && covered < ROSTER.length) {
  // Nêu rõ AI thiếu, không chỉ con số. "9/12 có dữ liệu" không nói được là ba
  // người nào đang bị trả lương theo mặc định.
  const thieu = ROSTER.filter((e) => !attVars[e.employeeCode]).map((e) => e.employeeCode);
  console.log(`    ⚠ ${thieu.length} người KHÔNG có chấm công, sẽ tính đủ ${std} ngày công: ${thieu.join(', ')}`);
}

const attendance = Object.fromEntries(
  ROSTER.map((e) => {
    const real = attVars[e.employeeCode];
    const other = OTHER[e.employeeCode] ?? { kpiScore: 100, advanceAmount: 0 };
    return [
      e.employeeCode,
      // Nhánh else chỉ tới được khi covered > 0 (người này thiếu) hoặc khi
      // người chạy đã bật ALLOW_NO_ATTENDANCE. Cả hai đường đều đã in cảnh báo
      // nêu rõ tên — không có đường nào trả đủ lương một cách âm thầm.
      real
        ? { ...real, ...other }
        : { workedDays: std, kpiScore: other.kpiScore, advanceAmount: other.advanceAmount },
    ];
  }),
);

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
