/**
 * ============================================================================
 * SEED — LOẠI CHÍNH SÁCH ĐẦU TIÊN: VN_PIT (thuế thu nhập cá nhân)
 * ============================================================================
 *
 * Chạy: npm run seed:tax
 *
 * VÌ SAO SCRIPT NÀY TỒN TẠI (nó từng không tồn tại, và đó là một lỗi thật):
 * ba bộ tham số VN_PIT đã có sẵn trong src/policy/tax-params.ts, nhưng thứ duy
 * nhất đưa chúng vào DB là `scripts/demo-law-change.ts` — một script DEMO.
 * Nghĩa là trên một DB trắng, `npm run seed:all` chạy tới `seed:salary` là nổ
 * `NOT_RESOLVABLE` cho VN_PIT, và cách "sửa" duy nhất là chạy một script demo
 * để lấy dữ liệu pháp lý. Bảng thuế là dữ liệu nghiệp vụ bắt buộc, không phải
 * đạo cụ trình diễn. Lỗi này không ai gặp cho tới khi deploy lên DB mới.
 *
 * Chạy lại bao nhiêu lần cũng cho cùng kết quả.
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
const { vnPitParamsSchema, vnPitJsonSchema, SEED_LEGACY_7B, SEED_BRIDGE_2026H1, SEED_VN_2026_5B } =
  await import('../src/policy/tax-params.js');
const { policyVersions } = await import('../src/db/schema.js');
const { sql, and, eq } = await import('drizzle-orm');

const KIND = 'VN_PIT';
const ACTOR = 'seed-admin';
const fmt = (n: number) => n.toLocaleString('vi-VN') + 'đ';

const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  SEED VN_PIT — biểu thuế thu nhập cá nhân, ba chế độ theo thời gian');
console.log('═'.repeat(78) + '\n');

// --- [1] Dọn dữ liệu cũ ----------------------------------------------------
await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
console.log('[1] ✓ Đã dọn VN_PIT cũ (seed chạy lại được nhiều lần)');

// --- [2] Đăng ký loại chính sách ------------------------------------------
await ensureKind(
  {
    code: KIND,
    nameVi: 'Thuế thu nhập cá nhân Việt Nam',
    nameEn: 'Vietnam Personal Income Tax',
    description:
      'Biểu thuế luỹ tiến từng phần, giảm trừ gia cảnh, các mức miễn giảm. ' +
      'Tham số thay đổi theo luật/nghị quyết — sửa trực tiếp trên giao diện.',
    paramsSchema: vnPitJsonSchema,
  },
  db,
);
console.log(`[2] ✓ Đã đăng ký '${KIND}' kèm JSON Schema ${JSON.stringify(vnPitJsonSchema).length} byte\n`);

// --- [3] Ba chế độ, xếp theo thời gian ------------------------------------
// Ba khoảng này NỐI nhau, không chồng, không hở: [2013-07-01, 2026-01-01),
// [2026-01-01, 2026-07-01), [2026-07-01, ∞). Nếu để hở thì resolvePolicy vào
// ngày trong khoảng hở sẽ ném NOT_RESOLVABLE — cố ý, nhưng không phải điều
// một hệ thống vừa cài đặt nên làm.
const seeds = [
  {
    params: SEED_LEGACY_7B,
    from: '2013-07-01',
    to: '2026-01-01',
    basis: 'TT 111/2013/TT-BTC; Luật Thuế TNCN 2007 (sửa đổi 2012)',
  },
  {
    params: SEED_BRIDGE_2026H1,
    from: '2026-01-01',
    to: '2026-07-01',
    basis: 'NQ 110/2025/UBTVQH15 (giảm trừ 15,5tr/6,2tr từ 01/01/2026), biểu 7 bậc',
  },
  {
    params: SEED_VN_2026_5B,
    from: '2026-07-01',
    to: null,
    basis: 'Luật 109/2025/QH15 — biểu 5 bậc',
  },
];

console.log('[3] Tạo và kích hoạt ba phiên bản');
for (const s of seeds) {
  const { version } = await createVersion(
    {
      kindCode: KIND,
      effectiveFrom: s.from,
      effectiveTo: s.to,
      legalBasis: s.basis,
      createdBy: ACTOR,
    },
    s.params,
    vnPitParamsSchema,
    db,
  );
  // Phải lọc theo CẢ kindCode lẫn version — số version chỉ duy nhất trong phạm
  // vi một loại. Bug này đã xảy ra hai lần.
  const row = (
    await db
      .select({ id: policyVersions.id })
      .from(policyVersions)
      .where(and(eq(policyVersions.kindCode, KIND), eq(policyVersions.version, version)))
      .limit(1)
  )[0];
  if (!row) throw new Error(`Không tìm thấy ${KIND} v${version}`);
  const { warnings } = await activateVersion(row.id, { id: ACTOR }, db);
  console.log(
    `    ✓ v${version}  ${s.params.regimeCode.padEnd(16)} ${s.from} → ${s.to ?? '(nay)'}  ` +
      `${s.params.brackets.length} bậc, giảm trừ ${fmt(s.params.selfDeduction)}` +
      (warnings.length ? '\n        ⚠ ' + warnings.join('\n        ⚠ ') : ''),
  );
}

// --- [4] Resolve thử ba mốc — chứng minh khoảng hiệu lực nối đúng ----------
console.log('\n[4] Resolve thử — mỗi kỳ phải rơi đúng chế độ của nó');
const expect: [string, string][] = [
  ['2025-09-30', 'LEGACY_7B'],
  ['2025-12-31', 'LEGACY_7B'], // ngày CUỐI của khoảng nửa mở vẫn thuộc khoảng cũ
  ['2026-01-01', 'BRIDGE_2026H1'], // và ngày ĐẦU thuộc khoảng mới
  ['2026-06-30', 'BRIDGE_2026H1'],
  ['2026-07-01', 'VN_2026_5B'],
  ['2026-09-30', 'VN_2026_5B'],
];
let ok = 0;
for (const [at, want] of expect) {
  const p = await resolvePolicy(KIND, at, vnPitParamsSchema, db);
  const hit = p.params.regimeCode === want;
  if (hit) ok++;
  console.log(
    `    ${hit ? '✓' : '✗'} ${at} → ${p.params.regimeCode.padEnd(16)} (v${p.version})` +
      (hit ? '' : `  MONG ĐỢI ${want}`),
  );
}
if (ok !== expect.length) {
  console.error(`\n✗ ${ok}/${expect.length} mốc đúng — khoảng hiệu lực đang sai`);
  await closeDb();
  process.exit(1);
}

console.log('\n' + '═'.repeat(78));
console.log(`  ✓ ${expect.length}/${expect.length} mốc resolve đúng chế độ`);
console.log('  Đổi luật = thêm một phiên bản trên giao diện /policies/VN_PIT/new,');
console.log('  không sửa code, không deploy lại.');
console.log('═'.repeat(78) + '\n');

await closeDb();
