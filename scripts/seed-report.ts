/**
 * ============================================================================
 * SEED — ĐỊNH NGHĨA BÁO CÁO (loại chính sách thứ sáu)
 * ============================================================================
 *
 * Chạy: npm run seed:report
 * Cần chạy `npm run payroll` trước để có dữ liệu cho báo cáo.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, getPool, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const {
  reportParamsSchema,
  reportJsonSchema,
  SEED_REPORT_PAYROLL_BY_DEPT,
  SEED_REPORT_PAYROLL_TOP,
} = await import('../src/policy/report-params.js');
const { runReport } = await import('../src/engine/report.js');
const { policyVersions } = await import('../src/db/schema.js');
const { sql, and, eq } = await import('drizzle-orm');

const KIND = 'REPORT_DEF';
const ACTOR = 'seed-admin';
const db = getDb();
const fmt = (n: number) => n.toLocaleString('vi-VN');

console.log('\n' + '═'.repeat(78));
console.log('  BÁO CÁO — loại chính sách thứ sáu, người dùng tự soạn bằng JSON');
console.log('═'.repeat(78) + '\n');

await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
await ensureKind(
  {
    code: KIND,
    nameVi: 'Định nghĩa báo cáo',
    nameEn: 'Report Definitions',
    description:
      'Nguồn dữ liệu, cột nhóm, chỉ tiêu, điều kiện lọc — tất cả là JSON trong database. ' +
      'Engine ghép SQL từ danh sách cột whitelist; giá trị luôn đi qua tham số, không bao giờ nối chuỗi.',
    paramsSchema: reportJsonSchema,
    // Nhiều mẫu/báo cáo phải cùng ACTIVE — độc quyền theo mã, không theo loại.
    exclusiveByCode: true,
  },
  db,
);
console.log(
  `[1] ✓ Đăng ký '${KIND}' với JSON Schema ${JSON.stringify(reportJsonSchema).length} byte`,
);

for (const [i, seed] of [SEED_REPORT_PAYROLL_BY_DEPT, SEED_REPORT_PAYROLL_TOP].entries()) {
  const { version, versionId } = await createVersion(
    {
      kindCode: KIND,
      effectiveFrom: '2024-01-01',
      effectiveTo: null,
      legalBasis: null,
      note: seed.description,
      createdBy: ACTOR,
    },
    seed,
    reportParamsSchema,
    db,
  );
  const res = await activateVersion(versionId, { id: ACTOR }, db);
  console.log(
    `[2.${i + 1}] ✓ v${version} ${seed.regimeCode} — ${seed.dimensions.length} cột nhóm, ` +
      `${seed.measures.length} chỉ tiêu, ${seed.filters.length} điều kiện` +
      (res.warnings.length > 0 ? ` (${res.warnings.length} cảnh báo)` : ''),
  );
}

// --- Chạy thử cả hai, trên dữ liệu thật ------------------------------------
console.log('\n[3] Chạy thử trên dữ liệu thật:');
const pool = getPool();
/** Query tham số hoá: giá trị đi qua $1, $2… của driver, không nối chuỗi. */
const executor = async (q: string, values: unknown[]) => {
  const r = await pool.query(q, values);
  return r.rows as Record<string, unknown>[];
};

const versions = await db
  .select()
  .from(policyVersions)
  .where(and(eq(policyVersions.kindCode, KIND), eq(policyVersions.status, 'ACTIVE')));

for (const v of versions) {
  const def = reportParamsSchema.parse(v.params);
  const res = await runReport(def, executor);
  console.log(`\n    ── ${def.regimeLabel} (${def.regimeCode}) ──`);
  console.log(`    ${res.columns.map((c) => c.code).join(' | ')}`);
  for (const row of res.rows.slice(0, 8)) {
    console.log(
      '    ' +
        res.columns
          .map((c) => {
            const raw = row[c.code.toLowerCase()] ?? row[c.code];
            return typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw))
              ? fmt(Number(raw))
              : String(raw ?? '');
          })
          .join(' | '),
    );
  }
  if (res.rows.length > 8) console.log(`    … và ${res.rows.length - 8} dòng nữa`);
  console.log(`    (${res.rows.length} dòng trong ${res.durationMs}ms)`);
}

console.log('\n    Xem tại /reports\n');
await closeDb();
