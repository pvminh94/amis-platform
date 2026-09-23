/**
 * ============================================================================
 * SEED THANH TOÁN NGÂN HÀNG — tham số 4 ngân hàng + tài khoản nhân viên + 1 lô UNC
 * ============================================================================
 *
 * Chạy: npm run seed:payment   (cần npm run payroll trước để có kỳ lương)
 *
 * ⚠️ SỐ TÀI KHOẢN TRONG FILE NÀY LÀ SỐ GIẢ. Trước khi dùng thật phải thay bằng số
 * thật đã đối chiếu với ngân hàng — đó chính là lý do cột `verified_at` tồn tại.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { bankPaymentBatches, employeeBankAccounts, payslips, payRuns } = await import(
  '../src/db/schema.js'
);
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { bankPayoutParamsSchema, bankPayoutJsonSchema, SEED_BANK_PAYOUT_VN } = await import(
  '../src/policy/bank-params.js'
);
const { createPaymentBatch } = await import('../src/lib/payment.js');
const { eq, desc, sql } = await import('drizzle-orm');

const db = getDb();
const fmt = (n: number) => n.toLocaleString('vi-VN');

console.log('\n' + '═'.repeat(78));
console.log('  THANH TOÁN NGÂN HÀNG — tham số, tài khoản, lô UNC');
console.log('═'.repeat(78) + '\n');

// --- 1. Tham số ngân hàng (policy kind thứ mười một) -----------------------
await ensureKind(
  {
    code: 'BANK_PAYOUT',
    nameVi: 'Tham số thanh toán ngân hàng',
    paramsSchema: bankPayoutJsonSchema,
    exclusiveByCode: true,
  },
  db,
);
for (const seed of SEED_BANK_PAYOUT_VN) {
  const { versionId, version } = await createVersion(
    {
      kindCode: 'BANK_PAYOUT',
      effectiveFrom: '2026-01-01',
      createdBy: 'seed',
      note: seed.regimeLabel,
    },
    seed,
    bankPayoutParamsSchema,
    db,
  );
  await activateVersion(versionId, { id: 'seed' }, db);
  console.log(`✓ ${seed.bankCode.padEnd(8)} ${seed.regimeLabel.padEnd(34)} v${version}`);
}

// --- 2. Tài khoản nhân viên -------------------------------------------------
const emps = await db.execute(
  sql`select employee_code, full_name from employees order by employee_code limit 12`,
);
const rows = (emps as unknown as { rows: { employee_code: string; full_name: string }[] }).rows;
if (rows.length === 0) {
  console.error('✗ chưa có nhân viên — chạy npm run payroll trước');
  process.exit(1);
}

// Hai ngân hàng để thử cả mẫu txt lẫn csv.
const BANKS = [
  { bankCode: 'VCBVNVX', bankName: 'Vietcombank', prefix: '00110' },
  { bankCode: 'VTCBVNVX', bankName: 'Techcombank', prefix: '19032' },
];

let inserted = 0;
for (const [i, e] of rows.entries()) {
  // NV012 cố ý KHÔNG có tài khoản — để đường "thiếu tài khoản" có dữ liệu thật
  // đi qua. Nếu mọi người đều có tài khoản thì nhánh báo lỗi đó không bao giờ
  // được chạy thử, và nó sẽ hỏng đúng lúc cần.
  if (e.employee_code === 'NV012') continue;

  const bank = BANKS[i % BANKS.length]!;
  const acct = `${bank.prefix}${String(1000000 + i * 137).slice(0, 7)}`;
  await db
    .insert(employeeBankAccounts)
    .values({
      employeeCode: e.employee_code,
      accountNumber: acct,
      accountName: e.full_name,
      bankCode: bank.bankCode,
      bankName: bank.bankName,
      branch: 'TP.HCM',
      isPrimary: true,
      // Hai tài khoản cố ý CHƯA đối chiếu để giao diện có cái mà cảnh báo.
      verifiedAt: i === 3 || i === 7 ? null : new Date('2026-08-01T00:00:00+07:00'),
      active: true,
    })
    .onConflictDoNothing();
  inserted++;
}
console.log(
  `✓ ${inserted} tài khoản chính (NV012 cố ý KHÔNG có — để thử nhánh thiếu tài khoản)`,
);

// --- 3. Xuất lô UNC --------------------------------------------------------
const [run] = await db.select().from(payRuns).orderBy(desc(payRuns.createdAt)).limit(1);
if (!run) {
  console.error('\n✗ chưa có kỳ lương — chạy npm run payroll trước');
  await closeDb();
  process.exit(1);
}
const slipCount = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(payslips)
  .where(eq(payslips.payRunId, run.id));
console.log(
  `\n--- Xuất lô cho kỳ ${String(run.periodMonth).padStart(2, '0')}/${run.periodYear} ` +
    `(${slipCount[0]!.n} phiếu) ---\n`,
);

// Xoá lô cũ của kỳ này để chạy lại được (ràng buộc một-lô-chưa-VOID sẽ chặn).
await db
  .update(bankPaymentBatches)
  .set({ status: 'VOID', notes: 'seed: thay bằng lô mới' })
  .where(eq(bankPaymentBatches.payRunId, run.id));

const batch = await createPaymentBatch(db, {
  payRunId: run.id,
  regimeCode: 'BANK_VCB',
  date: '2026-09-30',
  actor: 'seed',
});

console.log(`  Lô        : ${batch.batchNo}`);
console.log(`  File      : ${batch.fileName}`);
console.log(`  Số món    : ${batch.file.rowCount}`);
console.log(`  Tổng tiền : ${fmt(batch.file.totalAmount)} đ`);
console.log(`  Kích thước: ${fmt(batch.file.byteLength)} byte`);
console.log(`  SHA-256   : ${batch.file.checksum.slice(0, 32)}…`);

if (batch.missing.length > 0) {
  console.log(`\n  ⚠ ${batch.missing.length} nhân viên KHÔNG có trong file (thiếu tài khoản):`);
  for (const m of batch.missing) {
    console.log(`      ${m.employeeCode} ${m.fullName} — ${fmt(m.netPay)} đ chưa được trả`);
  }
}
if (batch.unverified.length > 0) {
  console.log(`\n  ⚠ ${batch.unverified.length} tài khoản CHƯA đối chiếu với ngân hàng:`);
  for (const u of batch.unverified) console.log(`      ${u.employeeCode} ${u.accountNumber}`);
}
if (batch.warnings.length > 0) {
  console.log(`\n  Cảnh báo khác: ${batch.warnings.length}`);
  for (const w of batch.warnings.slice(0, 4)) console.log(`      ${w}`);
}

console.log('\n  --- 4 dòng đầu của file ---');
for (const line of batch.file.content.split('\r\n').slice(0, 4)) {
  console.log(`  ${line.slice(0, 110)}`);
}
console.log('  …');
const last = batch.file.content.split('\r\n').filter((l) => l.startsWith('Z|'))[0];
console.log(`  ${last}`);

// Đối chiếu: tổng lô phải bằng tổng thực nhận của các phiếu CÓ tài khoản.
const chk = await db
  .select({
    total: sql<number>`coalesce(sum(${payslips.netPay}),0)::bigint`,
    n: sql<number>`count(*)::int`,
  })
  .from(payslips)
  .where(eq(payslips.payRunId, run.id));
const inFile = chk[0]!.total - batch.missing.reduce((s, m) => s + m.netPay, 0);
console.log(
  `\n  Đối chiếu: tổng thực nhận ${fmt(Number(chk[0]!.total))} đ − ` +
    `${fmt(batch.missing.reduce((s, m) => s + m.netPay, 0))} đ (thiếu TK) = ${fmt(Number(inFile))} đ`,
);
console.log(
  inFile === batch.file.totalAmount
    ? `  ✓ KHỚP tổng của lô (${fmt(batch.file.totalAmount)} đ)\n`
    : `  ✗ LỆCH: lô ${fmt(batch.file.totalAmount)} đ\n`,
);

await closeDb();
