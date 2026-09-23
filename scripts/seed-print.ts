/**
 * ============================================================================
 * SEED — MẪU IN (loại chính sách thứ năm)
 * ============================================================================
 *
 * Chạy: npm run seed:print
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { printParamsSchema, printJsonSchema, SEED_PRINT_PAYSLIP } = await import(
  '../src/policy/print-params.js'
);
const { policyVersions } = await import('../src/db/schema.js');
const { sql, and, eq } = await import('drizzle-orm');

const KIND = 'PRINT';
const ACTOR = 'seed-admin';
const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  MẪU IN — loại chính sách thứ năm, kế toán tự sửa không cần developer');
console.log('═'.repeat(78) + '\n');

await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
await ensureKind(
  {
    code: KIND,
    nameVi: 'Mẫu in',
    nameEn: 'Print Templates',
    description:
      'Mẫu phiếu lương, bảng chấm công, UNC… dưới dạng HTML + CSS trong database. ' +
      'Dữ liệu luôn được escape để chống XSS.',
    paramsSchema: printJsonSchema,
  },
  db,
);
console.log(`[1] ✓ Đăng ký '${KIND}' với JSON Schema ${JSON.stringify(printJsonSchema).length} byte`);

const { version } = await createVersion(
  {
    kindCode: KIND,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    legalBasis: null,
    note: 'Mẫu phiếu lương chuẩn',
    createdBy: ACTOR,
  },
  SEED_PRINT_PAYSLIP,
  printParamsSchema,
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

console.log(`[2] ✓ Kích hoạt v${version} — mẫu '${SEED_PRINT_PAYSLIP.regimeCode}'`);
console.log(`      ${SEED_PRINT_PAYSLIP.fields.length} trường dữ liệu, ${SEED_PRINT_PAYSLIP.numericInputs.length} biến số học`);
console.log(`      CSS ${SEED_PRINT_PAYSLIP.css.length} byte · thân mẫu ${SEED_PRINT_PAYSLIP.body.length} byte`);
console.log(`\n[3] Xem tại:  /print/PHIEU_LUONG`);
console.log('      (mở trong tab mới rồi Ctrl/Cmd + P để xuất PDF)\n');

await closeDb();
