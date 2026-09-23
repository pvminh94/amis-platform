/**
 * ============================================================================
 * SEED + DEMO — NGƯỠNG DUYỆT (loại chính sách thứ tư)
 * ============================================================================
 *
 * Chạy: npm run seed:approval
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
const { approvalParamsSchema, approvalJsonSchema, SEED_APPROVAL_VN_STD } = await import(
  '../src/policy/approval-params.js'
);
const { resolveApprovalChain } = await import('../src/engine/approval.js');
const { policyVersions } = await import('../src/db/schema.js');
const { sql, and, eq } = await import('drizzle-orm');

const KIND = 'APPROVAL';
const ACTOR = 'seed-admin';
const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  NGƯỠNG DUYỆT — loại chính sách thứ tư, form tự sinh từ JSON Schema');
console.log('═'.repeat(78) + '\n');

await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
await ensureKind(
  {
    code: KIND,
    nameVi: 'Ngưỡng duyệt',
    nameEn: 'Approval Thresholds',
    description:
      'Ai phải duyệt cái gì, ở mức nào. Mỗi loại chứng từ có một đường duyệt riêng. ' +
      'Sửa trực tiếp trên giao diện — không cần workflow designer.',
    paramsSchema: approvalJsonSchema,
  },
  db,
);
console.log(`[1] ✓ Đăng ký '${KIND}' với JSON Schema ${JSON.stringify(approvalJsonSchema).length} byte`);

const { version } = await createVersion(
  {
    kindCode: KIND,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    legalBasis: 'Quy chế nội bộ (ví dụ)',
    createdBy: ACTOR,
  },
  SEED_APPROVAL_VN_STD,
  approvalParamsSchema,
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
console.log(`[2] ✓ Kích hoạt v${version} — ${SEED_APPROVAL_VN_STD.levels.length} cấp, ${SEED_APPROVAL_VN_STD.rules.length} loại chứng từ`);

const policy = await resolvePolicy(KIND, '2026-09-30', approvalParamsSchema, db);

console.log('\n[3] CÙNG MỘT LOẠI ĐƠN, GIÁ TRỊ KHÁC NHAU → CHUỖI DUYỆT KHÁC NHAU\n');
const cases: Array<{ docType: string; value: number; note: string }> = [
  { docType: 'LEAVE', value: 2, note: 'nghỉ 2 ngày' },
  { docType: 'LEAVE', value: 5, note: 'nghỉ 5 ngày' },
  { docType: 'LEAVE', value: 15, note: 'nghỉ 15 ngày' },
  { docType: 'EXPENSE', value: 3_000_000, note: 'thanh toán 3 triệu' },
  { docType: 'EXPENSE', value: 300_000_000, note: 'thanh toán 300 triệu' },
  { docType: 'PAYRUN', value: 1_500_000_000, note: 'bảng lương 1,5 tỷ' },
];

for (const c of cases) {
  const r = resolveApprovalChain({ docType: c.docType, value: c.value }, policy.params);
  const chain = r.chain
    .map((s) => (s.isMatched ? `【${s.name}】` : s.name))
    .join('  →  ');
  console.log(`  ${c.note.padEnd(22)} (${r.chain.length} bước)`);
  console.log(`    ${chain}\n`);
}

console.log('  【…】 là bậc do ngưỡng chỉ định; các bước trước là chuỗi bắt buộc.');
console.log('  Đề nghị 300 triệu KHÔNG có Giám đốc nhân sự — cấp đó không nằm');
console.log('  trong đường duyệt chi phí, dù thứ bậc của nó ở giữa.\n');

await closeDb();
