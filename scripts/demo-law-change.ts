/**
 * ============================================================================
 * DEMO — ĐỔI LUẬT THUẾ MÀ KHÔNG SỬA CODE
 * ============================================================================
 *
 * Chạy: npm run demo
 *
 * Kịch bản: một nhân viên, cùng một mức lương, ba kỳ lương khác nhau.
 * Mỗi kỳ áp một bộ tham số thuế KHÁC NHAU — và bộ tham số đó đến từ
 * database, không phải từ hằng số trong file TypeScript.
 *
 * Sau đó ta "sửa luật": thêm một phiên bản chính sách mới có thuế suất thấp
 * hơn, kích hoạt nó, rồi tính lại. Số thuế đổi. Không build, không deploy,
 * không sửa một dòng code nào.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion, resolvePolicy, getAuditTrail } =
  await import('../src/policy/registry.js');
const {
  vnPitParamsSchema,
  vnPitJsonSchema,
  SEED_LEGACY_7B,
  SEED_BRIDGE_2026H1,
  SEED_VN_2026_5B,
} = await import('../src/policy/tax-params.js');
const { calculateProgressivePit, calculateTaxableIncome } = await import('../src/engine/pit.js');
const { policyKinds, policyVersions } = await import('../src/db/schema.js');
const { sql } = await import('drizzle-orm');
const { and, eq } = await import('drizzle-orm');

const KIND = 'VN_PIT';
const ACTOR = 'demo-admin';

const fmt = (n: number) => n.toLocaleString('vi-VN') + ' ₫';
const line = (c = '─') => console.log(c.repeat(78));

// ---------------------------------------------------------------------------
// Nhân viên mẫu: lương gross 45 triệu, 1 người phụ thuộc, BHXH 10,5%
// ---------------------------------------------------------------------------
const EMPLOYEE = {
  name: 'Nguyễn Văn A',
  grossIncome: 45_000_000,
  exemptIncome: 730_000,
  employeeSocialInsurance: 4_725_000, // 10,5% × 45tr
  voluntaryPensionContribution: 0,
  dependentCount: 1,
};

async function tinhLuong(kyLuong: string, db: ReturnType<typeof getDb>) {
  const policy = await resolvePolicy(KIND, kyLuong, vnPitParamsSchema, db);
  const ti = calculateTaxableIncome(EMPLOYEE, policy.params);
  const pit = calculateProgressivePit(ti.taxableIncome, policy.params);

  console.log(`  Kỳ lương          : ${kyLuong}`);
  console.log(`  Chế độ áp dụng    : ${policy.params.regimeLabel}`);
  console.log(`  (phiên bản v${policy.version}, căn cứ: ${policy.legalBasis ?? '—'})`);
  console.log(`  Thu nhập gross    : ${fmt(EMPLOYEE.grossIncome)}`);
  console.log(`  Giảm trừ bản thân : ${fmt(ti.selfDeduction)}`);
  console.log(`  Giảm trừ phụ thuộc: ${fmt(ti.dependentDeduction)} (${EMPLOYEE.dependentCount} người)`);
  console.log(`  Thu nhập tính thuế: ${fmt(ti.taxableIncome)}`);
  console.log(`  ► THUẾ TNCN       : ${fmt(pit.pit)}  (bậc ${pit.bracketIndex + 1}, khớp công thức tắt: ${pit.quickFormulaMatch ? 'CÓ' : 'KHÔNG'})`);
  console.log(`  Thực lĩnh         : ${fmt(EMPLOYEE.grossIncome - EMPLOYEE.employeeSocialInsurance - pit.pit)}`);
  return pit.pit;
}

const db = getDb();

try {
  console.log();
  line('═');
  console.log('  DEMO — ĐỔI LUẬT THUẾ MÀ KHÔNG SỬA CODE');
  line('═');

  // --- Bước 1: đăng ký loại chính sách và nạp các chế độ thuế ---------------
  console.log('\n[1] Đăng ký loại chính sách VN_PIT và nạp 3 chế độ thuế\n');

  // Dọn dữ liệu cũ để demo chạy lại được bao nhiêu lần cũng cho cùng kết quả.
  // Script demo mà chỉ chạy được một lần thì không phải demo, là bẫy.
  await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
  await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
  console.log('  ✓ Đã dọn dữ liệu VN_PIT cũ (demo chạy lại được nhiều lần)\n');
  await ensureKind(
    {
      code: KIND,
      nameVi: 'Thuế thu nhập cá nhân Việt Nam',
      nameEn: 'Vietnam Personal Income Tax',
      description:
        'Biểu thuế luỹ tiến từng phần, mức giảm trừ gia cảnh và các khoản miễn trừ. ' +
        'Tham số thay đổi theo văn bản pháp luật — sửa trực tiếp trên giao diện.',
      paramsSchema: vnPitJsonSchema,
    },
    db,
  );

  const seeds = [
    {
      params: SEED_LEGACY_7B,
      from: '2020-01-01',
      to: '2026-01-01',
      basis: 'TT 111/2013/TT-BTC; NQ 954/2020/UBTVQH14',
    },
    {
      params: SEED_BRIDGE_2026H1,
      from: '2026-01-01',
      to: '2026-07-01',
      basis: 'NQ 110/2025/UBTVQH15 (giảm trừ mới) + biểu 7 bậc',
    },
    {
      params: SEED_VN_2026_5B,
      from: '2026-07-01',
      to: null,
      basis: 'Luật Thuế TNCN 109/2025/QH15; NQ 110/2025/UBTVQH15',
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
      vnPitParamsSchema,
      db,
    );
    // LƯU Ý: phải lọc theo CẢ kindCode lẫn version. Số version chỉ duy nhất
    // trong phạm vi một loại — tra theo mình version sẽ vớ nhầm bản của loại
    // chính sách khác (đây là bug thật đã xảy ra khi viết demo này).
    const row = (await db
      .select({ id: policyVersions.id })
      .from(policyVersions)
      .where(and(eq(policyVersions.kindCode, KIND), eq(policyVersions.version, version)))
      .limit(1))[0];
    if (!row) throw new Error(`Không tìm thấy ${KIND} v${version}`);
    const { warnings } = await activateVersion(row.id, { id: ACTOR }, db);
    console.log(
      `  ✓ v${version}  ${s.params.regimeCode.padEnd(16)} ${s.from} → ${s.to ?? '(nay)'}${warnings.length ? '\n      ⚠ ' + warnings.join('\n      ⚠ ') : ''}`,
    );
  }

  // --- Bước 2: cùng một nhân viên, ba kỳ lương, ba kết quả ------------------
  console.log(`\n[2] CÙNG MỘT NHÂN VIÊN (${EMPLOYEE.name}, gross ${fmt(EMPLOYEE.grossIncome)}) — BA KỲ LƯƠNG\n`);

  const ky2025 = await tinhLuong('2025-09-30', db);
  console.log();
  line();
  console.log();
  const ky2026H1 = await tinhLuong('2026-03-31', db);
  console.log();
  line();
  console.log();
  const ky2026H2 = await tinhLuong('2026-09-30', db);

  // --- Bước 3: "SỬA LUẬT" ----------------------------------------------------
  console.log(`\n\n[3] GIẢ ĐỊNH LUẬT ĐỔI: từ 01/01/2027 nâng giảm trừ bản thân lên 20.000.000đ`);
  console.log('    (giả lập một Nghị quyết mới của UBTVQH)\n');

  const luatMoi = {
    ...SEED_VN_2026_5B,
    regimeCode: 'VN_2027_DEMO',
    regimeLabel: 'Giảm trừ 20tr (giả định 2027)',
    selfDeduction: 20_000_000,
  };

  const { versionId, version: vMoi } = await createVersion(
    {
      kindCode: KIND,
      effectiveFrom: '2027-01-01',
      effectiveTo: null,
      legalBasis: 'Nghị quyết GIẢ ĐỊNH của UBTVQH (demo)',
      createdBy: ACTOR,
      note: 'Demo: nâng giảm trừ bản thân lên 20 triệu',
    },
    luatMoi,
    vnPitParamsSchema,
    db,
  );
  const activated = await activateVersion(versionId, { id: ACTOR, reason: 'Demo đổi luật' }, db);
  console.log(`  ✓ Đã tạo và kích hoạt v${vMoi}`);
  console.log(`  ✓ Phiên bản cũ bị cắt khoảng hiệu lực: ${activated.archived.length} bản archived`);
  if (activated.warnings.length) console.log(`  ⚠ ${activated.warnings.join('\n  ⚠ ')}`);

  console.log(`\n    ⚠ QUAN TRỌNG: từ đầu script tới đây KHÔNG SỬA MỘT DÒNG CODE NÀO.`);
  console.log(`      Không build. Không deploy. Chỉ thêm dữ liệu vào PostgreSQL.\n`);

  line();
  console.log();
  const ky2027 = await tinhLuong('2027-03-31', db);

  // --- Bước 4: đối chiếu ------------------------------------------------------
  console.log('\n\n[4] ĐỐI CHIẾU — cùng một người, cùng mức lương, khác kỳ\n');
  console.log('  Kỳ          Chế độ                    Giảm trừ bản thân   Thuế TNCN      Chênh lệch');
  line();
  const rows = [
    ['2025-09', SEED_LEGACY_7B.regimeCode, SEED_LEGACY_7B.selfDeduction, ky2025],
    ['2026-03', SEED_BRIDGE_2026H1.regimeCode, SEED_BRIDGE_2026H1.selfDeduction, ky2026H1],
    ['2026-09', SEED_VN_2026_5B.regimeCode, SEED_VN_2026_5B.selfDeduction, ky2026H2],
    ['2027-03', luatMoi.regimeCode, luatMoi.selfDeduction, ky2027],
  ] as const;
  for (const [ky, code, gt, thue] of rows) {
    const chenh = thue - ky2025;
    console.log(
      `  ${ky}      ${code.padEnd(22)}  ${fmt(gt).padStart(16)}   ${fmt(thue).padStart(12)}   ${chenh === 0 ? '—' : (chenh > 0 ? '+' : '') + fmt(chenh)}`,
    );
  }

  // --- Bước 5: dấu vết --------------------------------------------------------
  console.log('\n\n[5] DẤU VẾT THAY ĐỔI (ai sửa luật, lúc nào)\n');
  const trail = await getAuditTrail(KIND, db);
  for (const t of trail.slice(0, 8)) {
    const when = new Date(t.at).toISOString().replace('T', ' ').slice(0, 19);
    console.log(
      `  ${when}  ${String(t.action).padEnd(9)} v${String(t.version ?? '—').padEnd(3)} bởi ${t.actorId}${t.reason ? '  — ' + t.reason : ''}`,
    );
  }
  console.log(`  ... tổng ${trail.length} bản ghi audit cho '${KIND}'`);

  const kinds = await db.select().from(policyKinds).where(eq(policyKinds.code, KIND));
  console.log(`\n[6] JSON Schema của '${KIND}' (${JSON.stringify(kinds[0]?.paramsSchema).length} byte)`);
  console.log('    → đây là thứ giao diện dùng để TỰ SINH form chỉnh sửa.');
  console.log('      Thêm loại chính sách mới = thêm một schema, không viết form mới.\n');

  line('═');
  console.log('  KẾT LUẬN');
  line('═');
  console.log('  Luật đổi → thêm một dòng policy_versions → engine tự áp dụng.');
  console.log('  Không sửa code. Không build. Không deploy.\n');
} catch (e) {
  console.error('\n✗ LỖI:', e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
