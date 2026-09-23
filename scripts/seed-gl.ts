/**
 * ============================================================================
 * SEED — ĐỊNH KHOẢN LƯƠNG VÀO SỔ CÁI (loại chính sách thứ bảy)
 * ============================================================================
 *
 * Chạy: npm run seed:gl
 *
 * Hai việc:
 *   1. Đăng ký loại GL_MAP và một bản định khoản hiệu lực.
 *   2. Nạp danh mục tài khoản — để số hiệu trên sổ cái tra ra được tên.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { glMapParamsSchema, glMapJsonSchema, SEED_GL_MAP_VN } = await import(
  '../src/policy/gl-params.js'
);
const { glAccounts } = await import('../src/db/schema.js');
const { sql } = await import('drizzle-orm');

const KIND = 'GL_MAP';
const ACTOR = 'seed-admin';
const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  ĐỊNH KHOẢN LƯƠNG — loại chính sách thứ bảy');
console.log('═'.repeat(78) + '\n');

// --- 1. Danh mục tài khoản --------------------------------------------------
//
// Số dư bình thường (normalSide) không phải để trang trí: nó quyết định một tài
// khoản tăng ở bên Nợ hay bên Có. Sai chỗ này thì mọi báo cáo số dư đều ngược dấu
// mà sổ vẫn "cân" — lỗi khó thấy nhất trong kế toán.
const CHART: Array<{
  code: string;
  nameVi: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  normalSide: 'DEBIT' | 'CREDIT';
  parentCode?: string;
}> = [
  { code: '1121', nameVi: 'Tiền gửi ngân hàng VND', type: 'ASSET', normalSide: 'DEBIT', parentCode: '112' },
  { code: '141', nameVi: 'Tạm ứng', type: 'ASSET', normalSide: 'DEBIT' },
  { code: '154', nameVi: 'Chi phí sản xuất kinh doanh dở dang', type: 'ASSET', normalSide: 'DEBIT' },
  { code: '334', nameVi: 'Phải trả người lao động', type: 'LIABILITY', normalSide: 'CREDIT' },
  { code: '3335', nameVi: 'Thuế thu nhập cá nhân phải nộp', type: 'LIABILITY', normalSide: 'CREDIT', parentCode: '333' },
  { code: '338', nameVi: 'Phải trả, phải nộp khác', type: 'LIABILITY', normalSide: 'CREDIT' },
  { code: '3383', nameVi: 'Bảo hiểm xã hội', type: 'LIABILITY', normalSide: 'CREDIT', parentCode: '338' },
  { code: '3384', nameVi: 'Bảo hiểm y tế', type: 'LIABILITY', normalSide: 'CREDIT', parentCode: '338' },
  { code: '3386', nameVi: 'Bảo hiểm thất nghiệp', type: 'LIABILITY', normalSide: 'CREDIT', parentCode: '338' },
  { code: '3388', nameVi: 'Bảo hiểm tai nạn lao động, bệnh nghề nghiệp', type: 'LIABILITY', normalSide: 'CREDIT', parentCode: '338' },
  { code: '6421', nameVi: 'Chi phí bán hàng', type: 'EXPENSE', normalSide: 'DEBIT', parentCode: '642' },
  { code: '6422', nameVi: 'Chi phí quản lý doanh nghiệp', type: 'EXPENSE', normalSide: 'DEBIT', parentCode: '642' },
];

await db.execute(sql`DELETE FROM gl_accounts`);
await db.insert(glAccounts).values(CHART.map((c) => ({ ...c, active: true })));
console.log(`[1] ✓ Nạp ${CHART.length} tài khoản vào danh mục`);

// --- 2. Loại chính sách và bản định khoản -----------------------------------
await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
await ensureKind(
  {
    code: KIND,
    nameVi: 'Định khoản lương vào sổ cái',
    nameEn: 'Payroll GL Mapping',
    description:
      'Bộ phận nào hạch toán vào tài khoản chi phí nào, và từng khoản lương vào tài ' +
      'khoản công nợ nào — tất cả là tham số. Đổi định khoản không cần sửa code và ' +
      'không cần deploy.',
    paramsSchema: glMapJsonSchema,
    // Luật kế toán áp dụng cho toàn doanh nghiệp, không có nhiều bản song song.
    exclusiveByCode: false,
  },
  db,
);
console.log(`[2] ✓ Đăng ký '${KIND}' với JSON Schema ${JSON.stringify(glMapJsonSchema).length} byte`);

const { version, versionId } = await createVersion(
  {
    kindCode: KIND,
    effectiveFrom: '2024-01-01',
    effectiveTo: null,
    legalBasis: 'Thông tư 200/2014/TT-BTC — Chế độ kế toán doanh nghiệp',
    note: 'Định khoản lương chuẩn theo TT200, chi phí tách theo bộ phận',
    createdBy: ACTOR,
  },
  SEED_GL_MAP_VN,
  glMapParamsSchema,
  db,
);
const res = await activateVersion(versionId, { id: ACTOR }, db);
console.log(
  `[3] ✓ v${version} ${SEED_GL_MAP_VN.regimeCode} — ` +
    `${Object.keys(SEED_GL_MAP_VN.departmentAccounts).length} bộ phận đã ánh xạ` +
    (res.warnings.length > 0 ? ` (${res.warnings.length} cảnh báo)` : ''),
);

console.log('\n  Bộ phận          → Tài khoản chi phí');
console.log('  ' + '─'.repeat(42));
for (const [dept, acc] of Object.entries(SEED_GL_MAP_VN.departmentAccounts)) {
  console.log(`  ${dept.padEnd(18)} → ${acc}`);
}
console.log(`  ${'(mặc định)'.padEnd(18)} → ${SEED_GL_MAP_VN.defaultExpenseAccount}`);

await closeDb();
console.log('\n  Xong. Ghi sổ bằng: npm run demo:gl\n');
