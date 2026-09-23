/**
 * ============================================================================
 * SEED CHẤM CÔNG — thiết bị, ngày lễ, lịch xếp ca, quẹt thẻ, rồi tính công
 * ============================================================================
 *
 * Chạy: npm run seed:attendance
 *
 * Quẹt thẻ được SINH CÓ CHỦ ĐÍCH chứ không ngẫu nhiên thuần: một lô quẹt "đẹp"
 * thì không chứng minh được gì. Lô này cố tình chứa đúng những tình huống khó mà
 * hệ thống phải xử lý đúng — đi trễ trong grace, trễ quá grace, thiếu một quẹt,
 * ca đêm vắt 0h, làm thêm ngày nghỉ, và một quẹt mồ côi.
 *
 * Dùng bộ sinh số giả ngẫu nhiên CÓ HẠT nên chạy lại bao nhiêu lần cũng ra đúng
 * một bộ dữ liệu. Seed mà mỗi lần ra một kết quả khác thì không dùng làm mốc đối
 * chiếu được.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const {
  dailyAttendance,
  employeeShifts,
  publicHolidays,
  rawPunches,
  shiftDevices,
} = await import('../src/db/schema.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { rotationParamsSchema, rotationJsonSchema, SEED_ROTATIONS_VN } = await import(
  '../src/policy/rotation-params.js'
);
const { computeAttendance } = await import('../src/lib/attendance.js');
const { resolveRotationShiftCode, resolveShift, absToCalendar } = await import('../src/engine/shift.js');
const { addDays, dayOfWeek, fromLocal } = await import('../src/engine/time.js');
const { sql, eq, and, gte, lte } = await import('drizzle-orm');

// ---------------------------------------------------------------------------
// Bộ sinh số giả ngẫu nhiên có hạt (LCG) — cùng hạt thì cùng dãy số.
// ---------------------------------------------------------------------------
let seedState = 20260915;
function rnd(): number {
  seedState = (seedState * 1103515245 + 12345) & 0x7fffffff;
  return seedState / 0x7fffffff;
}
const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;

// ---------------------------------------------------------------------------
// Ngày nghỉ lễ, tết năm 2026 — Điều 112 BLLĐ 2019 (11 ngày)
// ---------------------------------------------------------------------------
/**
 * Nguồn: Thông báo 9441/TB-BNV ngày 16/10/2025 của Bộ Nội vụ về lịch nghỉ Tết Âm
 * lịch và Quốc khánh 2026; các ngày còn lại theo đúng Điều 112 BLLĐ 2019.
 *
 * DANH SÁCH NÀY PHẢI ĐƯỢC CẬP NHẬT HẰNG NĂM. Đó là lý do nó nằm trong database
 * chứ không phải trong code: sang 2027 chỉ cần thêm dòng mới, không phải deploy.
 */
const HOLIDAYS_2026 = [
  { holidayDate: '2026-01-01', nameVi: 'Tết Dương lịch' },
  { holidayDate: '2026-02-16', nameVi: 'Tết Âm lịch — 29 tháng Chạp' },
  { holidayDate: '2026-02-17', nameVi: 'Tết Âm lịch — Mùng 1' },
  { holidayDate: '2026-02-18', nameVi: 'Tết Âm lịch — Mùng 2' },
  { holidayDate: '2026-02-19', nameVi: 'Tết Âm lịch — Mùng 3' },
  { holidayDate: '2026-02-20', nameVi: 'Tết Âm lịch — Mùng 4' },
  { holidayDate: '2026-04-26', nameVi: 'Giỗ Tổ Hùng Vương (10/3 âm lịch)' },
  { holidayDate: '2026-04-30', nameVi: 'Ngày Chiến thắng 30/4' },
  { holidayDate: '2026-05-01', nameVi: 'Ngày Quốc tế Lao động 1/5' },
  { holidayDate: '2026-09-01', nameVi: 'Quốc khánh — ngày liền kề trước' },
  { holidayDate: '2026-09-02', nameVi: 'Quốc khánh 2/9' },
];
const LEGAL_REF = 'Điều 112 BLLĐ 2019; TB 9441/TB-BNV 16/10/2025';
const HOLIDAY_SET = new Set(HOLIDAYS_2026.map((h) => h.holidayDate));

const FROM = '2026-09-01';
const TO = '2026-09-30';

const db = getDb();

// ---------------------------------------------------------------------------
console.log('\n=== SEED CHẤM CÔNG ===\n');

// 1. Thiết bị ------------------------------------------------------------
const DEVICES = [
  { serial: 'DEV-GATE-01', model: 'Hikvision DS-K1T671M', protocol: 'HIK_ISAPI', location: 'Cổng chính' },
  { serial: 'DEV-XUONG-02', model: 'Ronald Jack F18', protocol: 'ZK_ADMS', location: 'Xưởng sản xuất' },
  { serial: 'DEV-MOBILE', model: 'AMIS Mobile App', protocol: 'MOBILE', location: 'Di động (GPS)' },
] as const;
for (const d of DEVICES) {
  await db.insert(shiftDevices).values({ ...d }).onConflictDoNothing();
}
console.log(`✓ ${DEVICES.length} máy chấm công`);

// 2. Ngày lễ -------------------------------------------------------------
for (const h of HOLIDAYS_2026) {
  await db
    .insert(publicHolidays)
    .values({ ...h, legalRef: LEGAL_REF })
    .onConflictDoNothing();
}
console.log(`✓ ${HOLIDAYS_2026.length} ngày nghỉ lễ/tết 2026`);

// 3. Hệ xoay ca (policy kind thứ mười) ----------------------------------
await ensureKind(
  {
    code: 'SHIFT_ROTATION',
    nameVi: 'Hệ xoay ca',
    paramsSchema: rotationJsonSchema,
    exclusiveByCode: true,
  },
  db,
);
const rotSeed = SEED_ROTATIONS_VN[0]!;
const rot = await createVersion(
  {
    kindCode: 'SHIFT_ROTATION',
    effectiveFrom: '2026-01-01',
    legalBasis: 'Điều 108 BLLĐ 2019 (làm ca, làm đêm)',
    createdBy: 'seed',
    note: 'Xoay 3 ca 4 kíp, chu kỳ 8 ngày',
  },
  rotSeed,
  rotationParamsSchema,
  db,
);
await activateVersion(rot.versionId, { id: 'seed' }, db);
console.log(`✓ hệ xoay ${rotSeed.regimeCode} v${rot.version} — ${rotSeed.cycleLength} ngày, ${rotSeed.teamCount} kíp`);

// 4. Lịch xếp ca --------------------------------------------------------
/** NV001–NV004 hành chính, NV005–NV008 xoay 3 ca, NV009–NV012 ca gãy. */
const emps = await db.select({ code: sql<string>`employee_code` }).from(sql`(
  select employee_code from employees order by employee_code limit 12
) employees`);
const codes = emps.map((e) => e.code);
if (codes.length < 12) {
  console.error(`✗ cần 12 nhân viên, chỉ có ${codes.length}. Chạy npm run seed:salary trước.`);
  process.exit(1);
}

let rosterRows = 0;
for (let i = 0; i < codes.length; i++) {
  const code = codes[i]!;
  for (let d = FROM; d <= TO; d = addDays(d, 1)) {
    const dow = dayOfWeek(d); // 0 = Chủ nhật
    if (i < 4) {
      // Hành chính: nghỉ thứ Bảy, Chủ nhật và NGÀY LỄ — văn phòng đóng cửa.
      // Xưởng (kíp xoay) vẫn chạy ngày lễ, và đó chính là lúc phát sinh OT 300%.
      const rest = dow === 0 || dow === 6 || HOLIDAY_SET.has(d);
      await db
        .insert(employeeShifts)
        .values({ employeeCode: code, workDate: d, shiftCode: rest ? 'REST' : 'HC' })
        .onConflictDoNothing();
    } else if (i < 8) {
      // Xoay 3 ca 4 kíp: ngày nào cũng có dòng, ca do hệ xoay quyết định.
      await db
        .insert(employeeShifts)
        .values({
          employeeCode: code,
          workDate: d,
          rotationCode: rotSeed.regimeCode,
          anchorDate: FROM,
          teamIndex: i - 4,
        })
        .onConflictDoNothing();
    } else {
      // Ca gãy: nghỉ Chủ nhật.
      await db
        .insert(employeeShifts)
        .values({ employeeCode: code, workDate: d, shiftCode: dow === 0 ? 'REST' : 'GAY' })
        .onConflictDoNothing();
    }
    rosterRows++;
  }
}
console.log(`✓ ${rosterRows} dòng lịch (${codes.length} nhân viên × ${TO.slice(8)}/${TO.slice(5, 7)})`);

// Đọc LẠI lịch từ DB để sinh quẹt.
//
// Bản đầu tiên tính lại mã ca trong vòng sinh quẹt bằng cùng công thức với vòng
// xếp lịch, và hai chỗ đó lệch nhau đúng một điều kiện (ngày lễ): kết quả là quẹt
// được sinh cho người mà lịch ghi là NGHỈ, và OT ngày lễ phình ra gấp đôi. Hai
// bản sao của cùng một quyết định thì sớm muộn cũng lệch — nên chỉ giữ một bản,
// ở trong DB.
const rosterRowsDb = await db.select().from(employeeShifts);
const rosterMap = new Map<string, (typeof rosterRowsDb)[number]>();
for (const r of rosterRowsDb) rosterMap.set(`${r.employeeCode}|${r.workDate}`, r);

// 5. Quẹt thẻ ----------------------------------------------------------
/**
 * Sinh quẹt theo kịch bản có chủ đích.
 * Tỉ lệ được chọn để mọi nhánh của engine đều có dữ liệu thật đi qua.
 */
let punchCount = 0;
const punch = async (emp: string, device: string, when: Date, dir: 'IN' | 'OUT') => {
  await db
    .insert(rawPunches)
    .values({ employeeCode: emp, deviceSerial: device, punchedAt: when, direction: dir, source: 'DEVICE' })
    .onConflictDoNothing();
  punchCount++;
};

const stat = { onTime: 0, late: 0, missing: 0, overtime: 0, restWork: 0 };

for (let i = 0; i < codes.length; i++) {
  const code = codes[i]!;
  const device = i < 4 ? 'DEV-GATE-01' : i < 8 ? 'DEV-XUONG-02' : 'DEV-MOBILE';
  for (let d = FROM; d <= TO; d = addDays(d, 1)) {
    // Ca của ngày đó lấy TỪ LỊCH ĐÃ GHI, không tính lại.
    const sched = rosterMap.get(`${code}|${d}`);
    if (!sched) continue;
    const shiftCode = sched.rotationCode
      ? resolveRotationShiftCode(d, sched.anchorDate!, sched.teamIndex!, {
          code: rotSeed.regimeCode,
          name: rotSeed.regimeLabel,
          cycleLength: rotSeed.cycleLength,
          pattern: rotSeed.pattern,
          restCode: rotSeed.restCode,
          phaseStep: rotSeed.phaseStep,
          teamCount: rotSeed.teamCount,
        })
      : sched.shiftCode;

    const roll = rnd();

    // Ngày nghỉ: 6% đi làm thêm → OT cuối tuần.
    if (shiftCode === null || shiftCode === 'REST') {
      if (roll < 0.06) {
        await punch(code, device, fromLocal(d, 8 * 60 + 5), 'IN');
        await punch(code, device, fromLocal(d, 12 * 60 + 5), 'OUT');
        stat.restWork++;
      }
      continue;
    }

    // Đoạn giờ đọc lại từ chính sách đã seed, không tự dựng — để giờ quẹt được
    // sinh từ đúng định nghĩa mà engine sẽ dùng khi tính công.
    const pol = await db.execute(
      sql`select params from policy_versions where kind_code = 'SHIFT' and code = ${shiftCode}
          and status = 'ACTIVE' and effective_from <= ${d}
          and (effective_to is null or effective_to > ${d}) order by effective_from desc limit 1`,
    );
    const params = (pol as unknown as { rows: { params: Record<string, unknown> }[] }).rows[0]?.params;
    if (!params) continue;
    const resolved = resolveShift(
      {
        code: shiftCode,
        name: String(params.regimeLabel),
        type: params.shiftType as 'OFFICE',
        segments: params.segments as never,
      },
      d,
    );
    const abs = (m: number) => {
      const c = absToCalendar(d, m);
      return fromLocal(c.date, c.minutes);
    };

    // Kịch bản: 82% đúng giờ, 9% trễ, 5% thiếu một quẹt, 4% làm thêm.
    //
    // QUẸT ĐƯỢC SINH THEO TỪNG ĐOẠN. Bản đầu tiên chỉ sinh một cặp IN/OUT cho cả
    // ca, và với ca gãy (08:00–12:00 + 14:00–18:00) thì mỗi ngày đều thiếu hai
    // quẹt — kết quả là 105 ngày MISSING_PUNCH trong khi chỉ có 19 ngày thiếu
    // quẹt thật. Số liệu trông như engine sai, nhưng thật ra là dữ liệu seed sai:
    // người làm ca gãy quẹt 4 lần, không phải 2.
    const segs = resolved.segments;
    if (roll < 0.82) {
      stat.onTime++;
      for (const sg of segs) {
        await punch(code, device, abs(sg.absStart + Math.floor(rnd() * 8) - 12), 'IN');
        await punch(code, device, abs(sg.absEnd + Math.floor(rnd() * 10) - 5), 'OUT');
      }
    } else if (roll < 0.91) {
      stat.late++;
      // Trễ 3–45 phút ở đoạn ĐẦU: có trường hợp trong grace (10') và có trường
      // hợp quá grace. Các đoạn sau vẫn đúng giờ.
      for (const [n, sg] of segs.entries()) {
        const late = n === 0 ? 3 + Math.floor(rnd() * 42) : 0;
        await punch(code, device, abs(sg.absStart + late), 'IN');
        await punch(code, device, abs(sg.absEnd + Math.floor(rnd() * 10) - 5), 'OUT');
      }
    } else if (roll < 0.96) {
      stat.missing++;
      // Bỏ đúng MỘT quẹt — engine phải suy giờ còn lại và đánh dấu MISSING_PUNCH.
      // Với ca gãy, quẹt bị bỏ thường là lúc đổi đoạn: đó là quẹt người ta hay
      // quên nhất vì họ không rời xưởng.
      const dropIn = rnd() < 0.5;
      const dropIdx = Math.floor(rnd() * segs.length);
      for (const [n, sg] of segs.entries()) {
        if (!(n === dropIdx && dropIn)) {
          await punch(code, device, abs(sg.absStart + Math.floor(rnd() * 6)), 'IN');
        }
        if (!(n === dropIdx && !dropIn)) {
          await punch(code, device, abs(sg.absEnd + Math.floor(rnd() * 6) - 3), 'OUT');
        }
      }
    } else {
      stat.overtime++;
      for (const sg of segs) {
        await punch(code, device, abs(sg.absStart + 2), 'IN');
        await punch(code, device, abs(sg.absEnd + 2), 'OUT');
      }
      // Ở lại thêm 60–180 phút sau đoạn cuối.
      const last = segs[segs.length - 1]!;
      await punch(code, device, abs(last.absEnd + 60 + Math.floor(rnd() * 120)), 'OUT');
    }
  }
}
console.log(
  `✓ ${punchCount} quẹt thẻ (đúng giờ ${stat.onTime} · trễ ${stat.late} · ` +
    `thiếu quẹt ${stat.missing} · OT ${stat.overtime} · làm ngày nghỉ ${stat.restWork})`,
);

// Một quẹt MỒ CÔI có chủ đích: ngày không có lịch. Hệ thống phải báo, không im lặng.
await punch(codes[0]!, 'DEV-GATE-01', fromLocal('2026-08-25', 8 * 60), 'IN');

// 6. Tính công ---------------------------------------------------------
console.log('\n--- Tính công 09/2026 ---\n');
const summary = await computeAttendance(db, { from: FROM, to: TO });

console.log(`  Đã xử lý ${summary.daysProcessed} ngày công, ghi ${summary.rowsWritten} dòng`);
console.log(
  '  Trạng thái: ' +
    Object.entries(summary.byStatus)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ${v}`)
      .join(' · '),
);
const t = summary.totals;
console.log(
  `  Giờ công ${(t.workedMinutes / 60).toFixed(1)}h · giờ đêm ${(t.nightMinutes / 60).toFixed(1)}h · ` +
    `công quy chuẩn ${t.standardDays.toFixed(2)}`,
);
console.log(
  `  OT: ngày thường ${(t.otWeekdayMinutes / 60).toFixed(1)}h · cuối tuần ` +
    `${(t.otWeekendMinutes / 60).toFixed(1)}h · lễ ${(t.otHolidayMinutes / 60).toFixed(1)}h · ` +
    `đêm ${(t.otNightMinutes / 60).toFixed(1)}h`,
);
if (summary.orphanPunches.length) {
  console.log(`  ⚠ ${summary.orphanPunches.length} quẹt mồ côi (không thuộc ngày công nào):`);
  for (const o of summary.orphanPunches.slice(0, 5)) {
    console.log(`      ${o.employeeCode} — ${o.localDate}`);
  }
}
if (summary.errors.length) {
  console.log(`  ✗ ${summary.errors.length} dòng lỗi:`);
  for (const e of summary.errors.slice(0, 5)) {
    console.log(`      ${e.employeeCode} ${e.workDate} [${e.code}] ${e.message}`);
  }
}

// Đối chiếu nhanh với DB.
const chk = await db
  .select({
    n: sql<number>`count(*)::int`,
    worked: sql<number>`coalesce(sum(worked_minutes),0)::int`,
    night: sql<number>`coalesce(sum(night_minutes),0)::int`,
    statusOk: sql<number>`count(*) filter (where night_minutes <= worked_minutes)::int`,
  })
  .from(dailyAttendance)
  .where(and(gte(dailyAttendance.workDate, FROM), lte(dailyAttendance.workDate, TO)));
const c = chk[0]!;
console.log(
  `\n  Đối chiếu DB: ${c.n} dòng · ${c.worked} phút công · ${c.night} phút đêm · ` +
    `bất biến "giờ đêm <= giờ công" đúng ở ${c.statusOk}/${c.n} dòng`,
);
const sample = await db
  .select({
    code: dailyAttendance.employeeCode,
    date: dailyAttendance.workDate,
    shift: dailyAttendance.shiftCode,
    status: dailyAttendance.status,
    worked: dailyAttendance.workedMinutes,
    night: dailyAttendance.nightMinutes,
    ot: dailyAttendance.otWeekdayMinutes,
  })
  .from(dailyAttendance)
  .where(sql`night_minutes > 0`)
  .orderBy(dailyAttendance.workDate, dailyAttendance.employeeCode)
  .limit(1);
if (sample[0]) {
  const s = sample[0];
  console.log(
    `  Ví dụ ca đêm ${s.code} ngày ${s.date}: ca ${s.shift} · ${s.status} · ` +
      `${s.worked}' công, trong đó ${s.night}' giờ đêm`,
  );
}
console.log('');
await closeDb();
