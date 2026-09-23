/**
 * ============================================================================
 * SEED — ĐỊNH NGHĨA CA LÀM VIỆC (loại chính sách thứ tám)
 * ============================================================================
 *
 * Chạy: npm run seed:shift
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { shiftParamsSchema, shiftJsonSchema, SEED_SHIFTS_VN } = await import(
  '../src/policy/shift-params.js'
);
const { resolveShift } = await import('../src/engine/shift.js');
const { sql } = await import('drizzle-orm');

const KIND = 'SHIFT';
const ACTOR = 'seed-admin';
const db = getDb();
const SAMPLE_DATE = '2026-09-15';

console.log('\n' + '═'.repeat(78));
console.log('  ĐỊNH NGHĨA CA — loại chính sách thứ tám');
console.log('═'.repeat(78) + '\n');

await db.execute(sql`DELETE FROM policy_audit_logs WHERE kind_code = ${KIND}`);
await db.execute(sql`DELETE FROM policy_versions WHERE kind_code = ${KIND}`);
await ensureKind(
  {
    code: KIND,
    nameVi: 'Định nghĩa ca làm việc',
    nameEn: 'Shift Definitions',
    description:
      'Giờ vào/ra, số đoạn, giờ nghỉ, khung giờ đêm — tất cả là tham số trong ' +
      'database. Đổi giờ vào ca không cần sửa code và không cần deploy. Định ' +
      'nghĩa được kiểm tra bằng chính engine resolve ca, nên ca nào lưu được thì ' +
      'engine resolve được.',
    paramsSchema: shiftJsonSchema,
    // Mỗi mã ca là một thực thể riêng, nhiều ca cùng ACTIVE — như mẫu in và
    // báo cáo. Độc quyền theo (kind, code), không theo kind.
    exclusiveByCode: true,
  },
  db,
);
console.log(`[1] ✓ Đăng ký '${KIND}' với JSON Schema ${JSON.stringify(shiftJsonSchema).length} byte`);

console.log('\n[2] Nạp định nghĩa ca:');
console.log(
  `    ${'Mã'.padEnd(6)} ${'Tên'.padEnd(26)} ${'Đoạn giờ'.padEnd(20)} ` +
    `${'Giờ công'.padStart(8)} ${'Giờ đêm'.padStart(8)}  Qua 0h`,
);
console.log('    ' + '─'.repeat(78));

for (const seed of SEED_SHIFTS_VN) {
  const { version, versionId } = await createVersion(
    {
      kindCode: KIND,
      // KHÔNG truyền mã thực thể: registry tự lấy từ params.regimeCode. Đó là
      // quy ước cho mọi loại chính sách, và chính nó làm cho độc quyền theo
      // (kind, code) hoạt động — sửa ca CA3 tạo v2 của CA3, không đụng CA1.
      effectiveFrom: '2024-01-01',
      effectiveTo: null,
      legalBasis: 'Điều 106 BLLĐ 2019 — giờ làm việc ban đêm 22:00 đến 06:00',
      note: seed.regimeLabel,
      createdBy: ACTOR,
    },
    seed,
    shiftParamsSchema,
    db,
  );
  await activateVersion(versionId, { id: ACTOR }, db);

  // Resolve ngay trên một ngày mẫu để in ra số thật — không in lại tham số vừa
  // nhập, vì in tham số thì chỉ chứng minh được là mình gõ được chữ.
  const r = resolveShift(
    {
      code: seed.regimeCode,
      name: seed.regimeLabel,
      type: seed.shiftType,
      segments: seed.segments,
      nightStart: seed.nightStart,
      nightEnd: seed.nightEnd,
      standardHours: seed.standardHours ?? null,
    },
    SAMPLE_DATE,
  );
  const spans = r.segments.map((s) => `${s.startClock}–${s.endClock}`).join(' + ');
  console.log(
    `    ${seed.regimeCode.padEnd(6)} ${seed.regimeLabel.slice(0, 24).padEnd(26)} ${spans.padEnd(20)} ` +
      `${r.totalNetHours.toFixed(1).padStart(8)} ${r.nightHours.toFixed(1).padStart(8)}  ` +
      `${r.crossMidnight ? '✓ có' : '—'}  (v${version})`,
  );
}

console.log(
  `\n    Resolve thử ngày ${SAMPLE_DATE}: ca đêm kết thúc ngày ` +
    `${resolveShift(
      {
        code: 'CA3',
        name: 'Ca 3',
        type: 'NIGHT_CROSS_DAY',
        segments: SEED_SHIFTS_VN.find((s) => s.regimeCode === 'CA3')!.segments,
        nightStart: '22:00',
        nightEnd: '06:00',
        standardHours: null,
      },
      SAMPLE_DATE,
    ).endDate}`,
);

await closeDb();
console.log('\n  Xong.\n');
