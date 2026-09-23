/**
 * ============================================================================
 * SEED — LOẠI CHÍNH SÁCH THỨ HAI: VN_BHXH
 * ============================================================================
 *
 * Chạy: npm run seed:bhxh
 *
 * Script này tồn tại để chứng minh bằng số liệu, không phải bằng lời:
 * VN_BHXH là một loại chính sách HOÀN TOÀN MỚI. Không có form nào được viết
 * cho nó. Thứ duy nhất thêm vào tầng API là một dòng trong map VALIDATORS.
 * Giao diện /policies/VN_BHXH/new tự sinh form từ vnSiJsonSchema.
 *
 * Chạy lại bao nhiêu lần cũng cho cùng kết quả — script seed mà chỉ chạy được
 * một lần thì không phải seed, là bẫy.
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
const { vnSiParamsSchema, vnSiJsonSchema, SEED_SI_TO_2026_06, SEED_SI_FROM_2026_07 } =
  await import('../src/policy/si-params.js');
const { calculateSocialInsurance } = await import('../src/engine/si.js');
const { policyVersions } = await import('../src/db/schema.js');
const { sql, and, eq } = await import('drizzle-orm');

const KIND = 'VN_BHXH';
const ACTOR = 'seed-admin';
const fmt = (n: number) => n.toLocaleString('vi-VN') + 'đ';
const pct = (r: number) => (r * 100).toFixed(2).replace(/\.?0+$/, '') + '%';

const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  SEED LOẠI CHÍNH SÁCH MỚI: VN_BHXH — không viết form, không sửa engine');
console.log('═'.repeat(78) + '\n');

// --- [1] Dọn dữ liệu cũ ----------------------------------------------------
await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
console.log('[1] ✓ Đã dọn dữ liệu VN_BHXH cũ (seed chạy lại được nhiều lần)');

// --- [2] Đăng ký loại chính sách ------------------------------------------
await ensureKind(
  {
    code: KIND,
    nameVi: 'Bảo hiểm xã hội Việt Nam',
    nameEn: 'Vietnam Social Insurance',
    description:
      'Tỷ lệ đóng BHXH/BHYT/BHTN, mức tham chiếu, hệ số trần và lương tối thiểu vùng. ' +
      'Tham số thay đổi theo nghị định — sửa trực tiếp trên giao diện.',
    paramsSchema: vnSiJsonSchema,
  },
  db,
);
console.log(`[2] ✓ Đã đăng ký loại '${KIND}' kèm JSON Schema ${JSON.stringify(vnSiJsonSchema).length} byte`);
console.log('    → giao diện dùng đúng schema này để TỰ SINH form, không có form nào được viết tay\n');

// --- [3] Hai phiên bản có thật theo mức tham chiếu -------------------------
console.log('[3] Tạo và kích hoạt hai phiên bản (mức tham chiếu đổi từ 01/07/2026)');
const seeds = [
  {
    params: SEED_SI_TO_2026_06,
    from: '2024-07-01',
    to: '2026-07-01',
    basis: 'NĐ 73/2024 (mức tham chiếu 2.340.000đ); NĐ 293/2025 (lương tối thiểu vùng)',
  },
  {
    params: SEED_SI_FROM_2026_07,
    from: '2026-07-01',
    to: null,
    basis: 'NĐ 161/2026 (mức tham chiếu 2.530.000đ); Luật BHXH 2024 Điều 31',
  },
];

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
    vnSiParamsSchema,
    db,
  );
  // Phải lọc theo CẢ kindCode lẫn version — số version chỉ duy nhất trong phạm
  // vi một loại. Bug này đã xảy ra hai lần ở VN_PIT.
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
    `    ✓ v${version}  ${s.params.regimeCode.padEnd(18)} ${s.from} → ${s.to ?? '(nay)'}` +
      (warnings.length ? '\n        ⚠ ' + warnings.join('\n        ⚠ ') : ''),
  );
}

// --- [4] Tính thử: cùng một nhân viên, hai mốc ----------------------------
const EMP = {
  name: 'Nguyễn Văn A',
  contributionSalary: 60_000_000,
  wageRegion: 'I' as const,
  trainedWorker: true,
};

console.log(`\n[4] CÙNG MỘT NHÂN VIÊN — ${EMP.name}, lương đóng BH ${fmt(EMP.contributionSalary)}, Vùng ${EMP.wageRegion}, đã qua đào tạo\n`);

for (const ky of ['2026-06-30', '2026-09-30']) {
  const p = await resolvePolicy(KIND, ky, vnSiParamsSchema, db);
  const r = calculateSocialInsurance(EMP, p.params);
  console.log(`  Kỳ ${ky}  →  ${p.params.regimeLabel}  (v${p.version})`);
  console.log(`    Mức tham chiếu        : ${fmt(p.params.referenceSalary)}`);
  console.log(`    Trần BHXH/BHYT (20×)  : ${fmt(r.siCap)}   → căn cứ ${fmt(r.siBase)}${r.siHitCap ? '  ◄ CHẠM TRẦN' : ''}`);
  console.log(`    Sàn BHTN (vùng I +7%) : ${fmt(r.uiFloor)}   Trần BHTN (20× vùng): ${fmt(r.uiCap)}`);
  console.log(`                            → căn cứ BHTN ${fmt(r.uiBase)}`);
  console.log(
    `    NLĐ  (${pct(p.params.employee.socialInsurance + p.params.employee.healthInsurance + p.params.employee.unemployment)}) : ` +
      `BHXH ${fmt(r.employee.socialInsurance)} + BHYT ${fmt(r.employee.healthInsurance)} + BHTN ${fmt(r.employee.unemployment)} = ${fmt(r.employee.total)}`,
  );
  console.log(
    `    NSDLĐ (${pct(
      p.params.employer.socialInsurance +
        p.params.employer.healthInsurance +
        p.params.employer.unemployment +
        p.params.employer.accident,
    )}): BHXH ${fmt(r.employer.socialInsurance)} + BHYT ${fmt(r.employer.healthInsurance)} + BHTN ${fmt(r.employer.unemployment)} + TNLĐ ${fmt(r.employer.accident)} = ${fmt(r.employer.total)}\n`,
  );
}

console.log('═'.repeat(78));
console.log('  Hai kỳ chỉ khác nhau ở MỨC THAM CHIẾU — và con số đó nằm trong DB.');
console.log('  Mở /policies/VN_BHXH/new trên giao diện: form được sinh từ schema,');
console.log('  không có một dòng JSX nào viết riêng cho bảo hiểm.');
console.log('═'.repeat(78) + '\n');

await closeDb();
