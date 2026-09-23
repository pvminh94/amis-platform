/**
 * ============================================================================
 * SEED + DEMO — CÔNG THỨC LƯƠNG, CHẠY XUYÊN CẢ BA LOẠI CHÍNH SÁCH
 * ============================================================================
 *
 * Chạy: npm run seed:salary
 *
 * Đây là lần đầu ba engine nối với nhau thật:
 *
 *   VN_SALARY  → tính từng thành phần lương theo công thức trong DB
 *        ↓  (căn cứ đóng bảo hiểm = tổng thành phần có cờ inInsuranceBase)
 *   VN_BHXH    → trích BHXH/BHYT/BHTN
 *        ↓  (thu nhập chịu thuế = tổng thành phần có cờ taxable)
 *   VN_PIT     → thuế luỹ tiến
 *        ↓
 *   lương thực nhận
 *
 * Cả ba bộ tham số đều đọc từ policy_versions theo NGÀY CỦA KỲ LƯƠNG. Đổi kỳ
 * là đổi luật, không đổi code.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion, resolvePolicy } = await import(
  '../src/policy/registry.js'
);
const { vnSalaryParamsSchema, vnSalaryJsonSchema, SEED_SALARY_VN_STD } = await import(
  '../src/policy/salary-params.js'
);
const { vnSiParamsSchema } = await import('../src/policy/si-params.js');
const { vnPitParamsSchema } = await import('../src/policy/tax-params.js');
const { calculateSalary } = await import('../src/engine/salary.js');
const { calculateSocialInsurance } = await import('../src/engine/si.js');
const { calculateTaxableIncome, calculateProgressivePit } = await import('../src/engine/pit.js');
const { policyVersions } = await import('../src/db/schema.js');
const { sql, and, eq } = await import('drizzle-orm');

const KIND = 'VN_SALARY';
const ACTOR = 'seed-admin';
const fmt = (n: number) => n.toLocaleString('vi-VN') + 'đ';

const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  CÔNG THỨC LƯƠNG — ba engine nối nhau, tham số đọc từ database');
console.log('═'.repeat(78) + '\n');

// --- [1] Seed loại chính sách ---------------------------------------------
await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
await ensureKind(
  {
    code: KIND,
    nameVi: 'Công thức lương',
    nameEn: 'Salary Components',
    description:
      'Thành phần lương định nghĩa bằng biểu thức. Không dùng eval — có parser và ' +
      'evaluator riêng, biến phải khai báo tường minh.',
    paramsSchema: vnSalaryJsonSchema,
  },
  db,
);
console.log(`[1] ✓ Đăng ký '${KIND}' với JSON Schema ${JSON.stringify(vnSalaryJsonSchema).length} byte`);

const { version } = await createVersion(
  {
    kindCode: KIND,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    legalBasis: 'Quy chế lương nội bộ (ví dụ)',
    createdBy: ACTOR,
  },
  SEED_SALARY_VN_STD,
  vnSalaryParamsSchema,
  db,
);
const row = (
  await db
    .select({ id: policyVersions.id })
    .from(policyVersions)
    .where(and(eq(policyVersions.kindCode, KIND), eq(policyVersions.version, version)))
    .limit(1)
)[0];
if (!row) throw new Error(`Không tìm thấy ${KIND} v${version}`);
await activateVersion(row.id, { id: ACTOR }, db);
console.log(`[2] ✓ Kích hoạt v${version} — ${SEED_SALARY_VN_STD.components.length} thành phần lương`);
for (const c of SEED_SALARY_VN_STD.components) {
  console.log(`      ${String(c.sequence).padStart(2)}. ${c.code.padEnd(16)} ${c.formula}`);
}

// --- [3] Tính một phiếu lương thật ----------------------------------------
const VARS = {
  baseSalary: 25_000_000,
  workedDays: 22,
  standardDays: 22,
  kpiScore: 85,
  otNormalHours: 10,
  otWeekendHours: 4,
  otHolidayHours: 0,
  // 5 ca đêm × 8 giờ + vài giờ OT đêm đủ cả bốn hệ số của Điều 57 NĐ 145/2020
  nightHours: 40,
  otNightNormalWithDayOtHours: 2,
  otNightNormalNoDayOtHours: 3,
  otNightWeekendHours: 1,
  otNightHolidayHours: 0,
  hourlyRate: 120_000,
  mealDays: 22,
  lateCount: 5,
  advanceAmount: 2_000_000,
};
const KY = '2026-09-30';
const DEPENDENTS = 1;
const REGION = 'I' as const;

console.log(`\n[3] PHIẾU LƯƠNG — kỳ ${KY}, Vùng ${REGION}, ${DEPENDENTS} người phụ thuộc`);
console.log('    ' + Object.entries(VARS).map(([k, v]) => `${k}=${v}`).join('  '));

const salaryPolicy = await resolvePolicy(KIND, KY, vnSalaryParamsSchema, db);
const sal = calculateSalary({ variables: VARS }, salaryPolicy.params);

console.log(`\n    ── THÀNH PHẦN LƯƠNG (${salaryPolicy.params.regimeLabel})`);
for (const c of sal.components) {
  const flags = [c.taxable ? 'thuế' : null, c.inInsuranceBase ? 'BH' : null]
    .filter(Boolean)
    .join(', ');
  console.log(
    `    ${c.label.padEnd(38)} ${fmt(c.amount).padStart(14)}  ${flags ? '[' + flags + ']' : ''}`,
  );
}
console.log(`    ${'─'.repeat(66)}`);
console.log(`    ${'Tổng thu nhập'.padEnd(38)} ${fmt(sal.earningsTotal).padStart(14)}`);
console.log(`    ${'Khấu trừ'.padEnd(38)} ${fmt(sal.deductionsTotal).padStart(14)}`);
console.log(`    ${'Căn cứ đóng bảo hiểm'.padEnd(38)} ${fmt(sal.insuranceBaseSalary).padStart(14)}`);
console.log(`    ${'Thu nhập chịu thuế (trước giảm trừ)'.padEnd(38)} ${fmt(sal.taxableIncome).padStart(14)}`);

// --- Bảo hiểm -------------------------------------------------------------
const siPolicy = await resolvePolicy('VN_BHXH', KY, vnSiParamsSchema, db);
const si = calculateSocialInsurance(
  { contributionSalary: sal.insuranceBaseSalary, wageRegion: REGION, trainedWorker: true },
  siPolicy.params,
);
console.log(`\n    ── BẢO HIỂM (${siPolicy.params.regimeLabel})`);
console.log(`    Căn cứ BHXH/BHYT: ${fmt(si.siBase)} (sàn ${fmt(si.siFloor)} / trần ${fmt(si.siCap)})${si.siHitFloor ? ' ◄ chạm sàn' : si.siHitCap ? ' ◄ chạm trần' : ''}`);
console.log(`    Căn cứ BHTN     : ${fmt(si.uiBase)} (sàn ${fmt(si.uiFloor)} / trần ${fmt(si.uiCap)})`);
console.log(`    ${'NLĐ: BHXH + BHYT + BHTN'.padEnd(38)} ${fmt(si.employee.total).padStart(14)}`);
console.log(`    ${'NSDLĐ (chi phí, không trừ lương)'.padEnd(38)} ${fmt(si.employer.total).padStart(14)}`);

// --- Thuế -----------------------------------------------------------------
const pitPolicy = await resolvePolicy('VN_PIT', KY, vnPitParamsSchema, db);
const ti = calculateTaxableIncome(
  {
    grossIncome: sal.taxableIncome,
    exemptIncome: 0,
    employeeSocialInsurance: si.employee.total,
    voluntaryPensionContribution: 0,
    dependentCount: DEPENDENTS,
  },
  pitPolicy.params,
);
const pit = calculateProgressivePit(ti.taxableIncome, pitPolicy.params);
console.log(`\n    ── THUẾ TNCN (${pitPolicy.params.regimeLabel})`);
console.log(`    ${'Giảm trừ bản thân'.padEnd(38)} ${fmt(ti.selfDeduction).padStart(14)}`);
console.log(`    ${`Giảm trừ ${DEPENDENTS} người phụ thuộc`.padEnd(38)} ${fmt(ti.dependentDeduction).padStart(14)}`);
console.log(`    ${'Thu nhập tính thuế'.padEnd(38)} ${fmt(ti.taxableIncome).padStart(14)}`);
console.log(`    ${'Thuế phải nộp (bậc ' + (pit.bracketIndex + 1) + ')'.padEnd(38)} ${fmt(pit.pit).padStart(14)}${pit.quickFormulaMatch ? '' : '  ✗ LỆCH CÔNG THỨC NHANH'}`);

// --- Thực nhận ------------------------------------------------------------
const net = sal.netFromComponents - si.employee.total - pit.pit;
console.log(`\n    ${'═'.repeat(66)}`);
console.log(`    ${'LƯƠNG THỰC NHẬN'.padEnd(38)} ${fmt(net).padStart(14)}`);
console.log(`    ${'═'.repeat(66)}`);

console.log(`
  Ba bộ tham số trên đến từ BA loại chính sách khác nhau, mỗi loại một dòng
  trong policy_versions, và mỗi loại được chỉnh bằng một form TỰ SINH từ
  JSON Schema. Đổi bất kỳ con số nào trên giao diện là phiếu lương này đổi.
`);

await closeDb();
