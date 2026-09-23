/**
 * ============================================================================
 * TEST SERVICE CHẤM CÔNG — chạy trên PostgreSQL THẬT
 * ============================================================================
 *
 * Không mock. Lý do: phần lớn rủi ro của tầng này nằm ở SQL và ở ràng buộc DB —
 * UNIQUE (nhân viên, ngày), CHECK giờ đêm <= giờ làm, khoá ngoại vào nhân viên
 * và vào thiết bị. Mock không thực thi cái nào trong số đó, nên test trên mock sẽ
 * xanh trong khi hệ thống thật cho ghi hai dòng công cho cùng một người một ngày.
 *
 * MỖI TEST CHẠY TRONG MỘT TRANSACTION VÀ ROLLBACK. Không xoá dữ liệu đã tạo bằng
 * lệnh DELETE: xoá thì không chứng minh được là không để lại gì, và nếu test nổ
 * giữa chừng thì rác nằm lại trong DB cho lần chạy sau.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Nạp .env thủ công — npm/vitest KHÔNG tự làm việc này.
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const {
  dailyAttendance,
  employees,
  employeeShifts,
  publicHolidays,
  rawPunches,
  shiftDevices,
} = await import('../src/db/schema.js');
const { computeAttendance, AttendanceServiceError } = await import('../src/lib/attendance.js');
const { pairPunches } = await import('../src/engine/attendance.js');
const { resolveShift } = await import('../src/engine/shift.js');
const { fromLocal } = await import('../src/engine/time.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { rotationParamsSchema, rotationJsonSchema, SEED_ROTATIONS_VN } = await import(
  '../src/policy/rotation-params.js'
);
const { eq, and, sql } = await import('drizzle-orm');

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** Chạy trong transaction rồi rollback — trả về kết quả, không để lại dữ liệu. */
async function rolled<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = getDb();
  let out: T | undefined;
  const MARK = 'ROLLBACK_ATTENDANCE_TEST';
  try {
    await db.transaction(async (tx) => {
      out = await fn(tx);
      throw new Error(MARK);
    });
  } catch (e) {
    if ((e as Error).message !== MARK) throw e;
  }
  return out as T;
}

const D = '2026-09-15'; // thứ Ba
const SAT = '2026-09-19'; // thứ Bảy
const DEVICE = 'TEST-DEV-01';

/**
 * Mã nhân viên DUY NHẤT cho mỗi lần chạy, và nhân viên đó được tạo ngay trong
 * transaction rồi rollback theo.
 *
 * Bản đầu tiên dùng thẳng 'NV001' của seed và chỉ pass khi DB chưa seed: vừa chạy
 * `npm run seed:attendance` xong là 12/16 test nổ vì `uq_employee_shifts_person_day`
 * — lịch của NV001 ngày 15/09 đã tồn tại. Một test chỉ pass nhờ thứ tự chạy thì
 * không phải test, nó là một cái bẫy.
 */
const EMP = `TATT-${Date.now().toString(36).toUpperCase()}`;

/** Tạo nhân viên + thiết bị test, trả về hàm ghi quẹt. */
async function setupDevice(tx: Tx) {
  await tx.insert(employees).values({
    employeeCode: EMP,
    fullName: 'Nhân viên test chấm công',
    department: 'Test',
    wageRegion: 'I',
    baseSalary: 10_000_000,
  });
  await tx
    .insert(shiftDevices)
    .values({ serial: DEVICE, model: 'Test', protocol: 'MANUAL', location: 'Test' })
    .onConflictDoNothing();
  return (when: Date, direction: 'IN' | 'OUT' | null = null, emp = EMP) =>
    tx.insert(rawPunches).values({
      employeeCode: emp,
      deviceSerial: DEVICE,
      punchedAt: when,
      direction,
      source: 'MANUAL',
    });
}

async function roster(tx: Tx, workDate: string, shiftCode: string | null, emp = EMP) {
  await tx.insert(employeeShifts).values({ employeeCode: emp, workDate, shiftCode });
}

/**
 * Tạo và kích hoạt một bản SHIFT_ROTATION ngay trong transaction.
 *
 * Test tự tạo dữ liệu thay vì dựa vào seed: `npm run verify` chạy migrate chứ
 * không chạy seed, nên một test phụ thuộc seed sẽ đỏ trên DB mới dựng — và đỏ vì
 * thiếu dữ liệu chứ không vì code sai, tức là test không còn nói được gì.
 */
async function seedRotation(tx: Tx) {
  await ensureKind(
    {
      code: 'SHIFT_ROTATION',
      nameVi: 'Hệ xoay ca',
      paramsSchema: rotationJsonSchema,
      exclusiveByCode: true,
    },
    tx,
  );
  const seed = SEED_ROTATIONS_VN[0]!;
  const { versionId } = await createVersion(
    {
      kindCode: 'SHIFT_ROTATION',
      effectiveFrom: '2026-01-01',
      createdBy: 'test',
      note: 'test fixture',
    },
    seed,
    rotationParamsSchema,
    tx,
  );
  await activateVersion(versionId, { id: 'test' }, tx);
}

/** Đọc dòng công đã ghi. */
const row = (tx: Tx, workDate: string, emp = EMP) =>
  tx
    .select()
    .from(dailyAttendance)
    .where(and(eq(dailyAttendance.employeeCode, emp), eq(dailyAttendance.workDate, workDate)))
    .limit(1)
    .then((r) => r[0]);

afterAll(async () => {
  await closeDb();
});

// ===========================================================================

describe('ngày thường', () => {
  it('quẹt đúng giờ ca HC → PRESENT, 480 phút, và ghi lại phiên bản ca đã dùng', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, D, 'HC');
      await punch(fromLocal(D, 7 * 60 + 58), 'IN');
      await punch(fromLocal(D, 17 * 60 + 5), 'OUT');

      const summary = await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      return { summary, row: await row(tx, D) };
    });

    expect(r.summary.rowsWritten).toBe(1);
    expect(r.summary.errors).toEqual([]);
    expect(r.row!.status).toBe('PRESENT');
    expect(r.row!.workedMinutes).toBe(480);
    expect(r.row!.nightMinutes).toBe(0);
    // Ngày công quy chuẩn = 480 / (8×60) = 1.000 — đây là con số lương dùng.
    expect(Number(r.row!.standardDays)).toBe(1);
    // Phải ghi lại phiên bản định nghĩa ca: ba tháng sau còn biết tính bằng bản nào.
    expect(r.row!.shiftPolicyVersionId).not.toBeNull();
    expect(r.row!.shiftCode).toBe('HC');
    expect(r.row!.dayKind).toBe('WORKING_DAY');
    expect(r.row!.punchCount).toBe(2);
    expect(r.row!.checkInAt).not.toBeNull();
    expect(r.row!.checkOutAt).not.toBeNull();
    // Tham số ghép cặp được ghi lại, không phải để trống.
    expect((r.row!.pairingConfig as Record<string, number>).graceMinutes).toBe(10);
  });

  it('đi trễ 25 phút → LATE và đếm đúng số phút', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, D, 'HC');
      await punch(fromLocal(D, 8 * 60 + 25), 'IN');
      await punch(fromLocal(D, 17 * 60), 'OUT');
      await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      return row(tx, D);
    });
    expect(r!.status).toBe('LATE');
    expect(r!.lateMinutes).toBe(25);
  });
});

describe('ca đêm vắt 0h', () => {
  it('quẹt 22:00 ngày D và 06:00 ngày D+1 → 480 phút, cả 480 là giờ đêm', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, D, 'CA3');
      await punch(fromLocal(D, 22 * 60), 'IN');
      // Quẹt này NẰM NGOÀI khoảng [D, D] theo ngày lịch — nếu truy vấn quẹt chỉ
      // lấy đúng khoảng đó thì ca đêm thành "thiếu quẹt ra" cho đúng ca khó nhất.
      await punch(fromLocal('2026-09-16', 6 * 60), 'OUT');
      const summary = await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      return { summary, row: await row(tx, D) };
    });

    expect(r.summary.errors).toEqual([]);
    expect(r.row!.status).toBe('PRESENT');
    expect(r.row!.workedMinutes).toBe(480);
    expect(r.row!.nightMinutes).toBe(480);
    expect(r.row!.shiftCode).toBe('CA3');
    // Giờ ra phải là 06:00 ngày HÔM SAU, không phải 06:00 cùng ngày.
    expect(r.row!.checkOutAt!.toISOString()).toBe(fromLocal('2026-09-16', 6 * 60).toISOString());
  });
});

describe('ngày nghỉ và ngày lễ', () => {
  it('ngày nghỉ có quẹt → OT cuối tuần, công chính bằng 0', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, SAT, 'REST');
      await punch(fromLocal(SAT, 8 * 60), 'IN');
      await punch(fromLocal(SAT, 17 * 60), 'OUT');
      await computeAttendance(tx, { from: SAT, to: SAT, employeeCodes: [EMP] });
      return row(tx, SAT);
    });
    expect(r!.dayKind).toBe('WEEKLY_REST');
    expect(r!.otWeekendMinutes).toBe(540);
    expect(r!.otWeekdayMinutes).toBe(0);
    // Nếu standardDays > 0 thì kỳ lương sẽ trả hai lần cho cùng 9 tiếng đó.
    expect(Number(r!.standardDays)).toBe(0);
    expect(r!.shiftCode).toBe('REST');
  });

  it('ngày lễ không đi làm → HOLIDAY_OFF, không phải ABSENT', async () => {
    const r = await rolled(async (tx) => {
      await setupDevice(tx);
      await tx
        .insert(publicHolidays)
        .values({ holidayDate: D, nameVi: 'Ngày test' })
        .onConflictDoNothing();
      await roster(tx, D, 'REST');
      await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      return row(tx, D);
    });
    expect(r!.status).toBe('HOLIDAY_OFF');
    expect(r!.dayKind).toBe('PUBLIC_HOLIDAY');
    expect(r!.absentMinutes).toBe(0);
  });
});

describe('quẹt mồ côi — không được im lặng bỏ qua', () => {
  it('quẹt vào ngày không có lịch → hiện trong orphanPunches', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      // KHÔNG tạo dòng lịch cho ngày D.
      await punch(fromLocal(D, 9 * 60));
      return computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
    });
    expect(r.orphanPunches.length).toBe(1);
    expect(r.orphanPunches[0]!.employeeCode).toBe(EMP);
    expect(r.orphanPunches[0]!.localDate).toBe(D);
    expect(r.daysProcessed).toBe(0);
  });

  it('ngày nghỉ chỉ có MỘT quẹt → không tính OT nhưng phải cảnh báo', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, SAT, 'REST');
      await punch(fromLocal(SAT, 9 * 60));
      await computeAttendance(tx, { from: SAT, to: SAT, employeeCodes: [EMP] });
      return row(tx, SAT);
    });
    expect(r!.otWeekendMinutes).toBe(0);
    expect((r!.warnings as string[]).some((w) => w.includes('đúng 1 quẹt'))).toBe(true);
  });
});

describe('lỗi một dòng không kéo sập cả đợt', () => {
  it('mã ca không tồn tại → dòng đó vào errors, các dòng khác vẫn ghi', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, D, 'KHONG_TON_TAI');
      await roster(tx, '2026-09-16', 'HC', EMP);
      await punch(fromLocal('2026-09-16', 8 * 60), 'IN');
      await punch(fromLocal('2026-09-16', 17 * 60), 'OUT');
      const summary = await computeAttendance(tx, { from: D, to: '2026-09-16', employeeCodes: [EMP] });
      return { summary, ok: await row(tx, '2026-09-16') };
    });
    expect(r.summary.errors.length).toBe(1);
    expect(r.summary.errors[0]!.workDate).toBe(D);
    // Dòng hợp lệ vẫn phải được ghi — nếu không thì một lỗi cấu hình làm mất
    // lương của cả tháng mà không ai biết cho tới kỳ trả lương.
    expect(r.summary.rowsWritten).toBe(1);
    expect(r.ok!.status).toBe('PRESENT');
  });
});

describe('tính lại phải ra đúng số cũ', () => {
  it('chạy hai lần → cùng số dòng ghi, không nhân đôi, số liệu giống hệt', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, D, 'HC');
      await punch(fromLocal(D, 8 * 60), 'IN');
      await punch(fromLocal(D, 18 * 60), 'OUT');

      const s1 = await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      const s2 = await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      const count = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(dailyAttendance)
        .where(eq(dailyAttendance.employeeCode, EMP));
      return { s1, s2, count: count[0]!.n, row: await row(tx, D) };
    });

    expect(r.s2.rowsWritten).toBe(r.s1.rowsWritten);
    // UNIQUE (employee_code, work_date) + onConflictDoUpdate: hai lần chạy chỉ có
    // MỘT dòng. Nếu thành hai thì bảng lương sẽ cộng trùng ngày công.
    expect(r.count).toBe(1);
    expect(JSON.stringify(r.s2.totals)).toBe(JSON.stringify(r.s1.totals));
    expect(r.row!.workedMinutes).toBe(480);
    expect(r.row!.otWeekdayMinutes).toBe(60); // ở lại 17:00–18:00
  });
});

describe('kiểm tra khoảng ngày', () => {
  it('from > to → ném BAD_RANGE', async () => {
    await expect(
      rolled((tx) => computeAttendance(tx, { from: '2026-09-20', to: '2026-09-10' })),
    ).rejects.toThrowError(AttendanceServiceError);
  });

  it('ngày sai định dạng → ném', async () => {
    await expect(
      rolled((tx) => computeAttendance(tx, { from: '15/09/2026', to: '2026-09-20' })),
    ).rejects.toThrowError(AttendanceServiceError);
  });

  it('khoảng vượt 92 ngày → ném (không để một request tính cả năm)', async () => {
    await expect(
      rolled((tx) => computeAttendance(tx, { from: '2026-01-01', to: '2026-12-31' })),
    ).rejects.toThrowError(/92 ngày/);
  });

  it('không có lịch nào → trả summary rỗng, không ném', async () => {
    const r = await rolled((tx) =>
      computeAttendance(tx, { from: '2030-01-01', to: '2030-01-31', employeeCodes: [EMP] }),
    );
    expect(r.daysProcessed).toBe(0);
    expect(r.rowsWritten).toBe(0);
  });
});

describe('ca xoay', () => {
  it('lịch khai rotationCode → engine tự suy ra ca của ngày đó', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await seedRotation(tx);
      // Ngày neo: kíp 0 làm CA1 (đã kiểm chứng bằng test engine, tính tay).
      await tx.insert(employeeShifts).values({
        employeeCode: EMP,
        workDate: D,
        rotationCode: 'ROT_3CA4KIP',
        anchorDate: D,
        teamIndex: 0,
      });
      await punch(fromLocal(D, 6 * 60), 'IN');
      await punch(fromLocal(D, 14 * 60), 'OUT');
      const summary = await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      return { summary, row: await row(tx, D) };
    });

    // Ngày neo của hệ 3 ca 4 kíp: kíp 0 → CA1 (tính tay trong tests/shift.spec.ts).
    expect(r.summary.errors).toEqual([]);
    expect(r.row!.shiftCode).toBe('CA1');
    expect(r.row!.workedMinutes).toBe(480);
  });

  it('lịch ca xoay thiếu teamIndex → lỗi rõ ràng, không suy đoán', async () => {
    const r = await rolled(async (tx) => {
      await setupDevice(tx);
      await seedRotation(tx);
      // teamIndex = 99 trong hệ chỉ có 4 kíp. CHECK ở DB không chặn được cái này
      // (nó chỉ chặn teamIndex >= 0) nên engine phải chặn.
      await tx.insert(employeeShifts).values({
        employeeCode: EMP,
        workDate: D,
        rotationCode: 'ROT_3CA4KIP',
        anchorDate: D,
        teamIndex: 99, // vượt số kíp
      });
      return computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
    });
    // Kíp 99 trong hệ 4 kíp phải là LỖI, không phải âm thầm xếp vào một ca nào đó.
    expect(r.rowsWritten).toBe(0);
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.code).toBe('TEAM_INDEX_OUT_OF_RANGE');
  });
});

describe('nhất quán giữa service và engine', () => {
  it('ngày nghỉ không quẹt: service phải cho ra đúng cái pairPunches cho ra', async () => {
    // `restDayResult` được viết tay (một đoạn 0 phút thì resolveShift từ chối),
    // nên phải có phép thử giữ nó không lệch khỏi engine.
    const fromEngine = pairPunches(resolveShift(
      {
        code: 'HC',
        name: 'HC',
        type: 'OFFICE',
        segments: [{ name: 'a', start: '08:00', end: '17:00' }],
      },
      D,
    ), [], 'WEEKLY_REST');

    const r = await rolled(async (tx) => {
      await setupDevice(tx);
      await roster(tx, D, 'REST');
      await computeAttendance(tx, { from: D, to: D, employeeCodes: [EMP] });
      return row(tx, D);
    });

    expect(r!.status).toBe(fromEngine.status);
    expect(r!.workedMinutes).toBe(fromEngine.workedMinutes);
    expect(Number(r!.standardDays)).toBe(fromEngine.standardDays);
    expect(r!.absentMinutes).toBe(fromEngine.absentMinutes);
  });
});

// ===========================================================================
// TỔNG HỢP CHO KỲ LƯƠNG
// ===========================================================================

const { aggregateAttendanceForPayroll } = await import('../src/lib/attendance.js');

/** Tháng dùng cho test tổng hợp — chọn tháng không có dữ liệu seed. */
const PY = 2031;
const PM = 3;
const P01 = '2031-03-03'; // thứ Hai
const P02 = '2031-03-04';

describe('aggregateAttendanceForPayroll', () => {
  it('OT đêm ngày thường KHÔNG có OT ban ngày → vào ô 200%', async () => {
    // Ca CA1 06:00–14:00, quẹt 04:00. Phần 04:00–06:00 là OT nằm TRONG khung đêm
    // (22:00–06:00) và ngày đó KHÔNG có OT ban ngày nào.
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, P01, 'CA1');
      await punch(fromLocal(P01, 4 * 60), 'IN');
      await punch(fromLocal(P01, 14 * 60), 'OUT');
      await computeAttendance(tx, { from: P01, to: P01, employeeCodes: [EMP] });
      return aggregateAttendanceForPayroll(tx, { periodYear: PY, periodMonth: PM });
    });
    const v = r[EMP]!;
    expect(v.otNightNormalNoDayOtHours).toBe(2);
    expect(v.otNightNormalWithDayOtHours).toBe(0);
  });

  it('OT đêm ngày thường CÓ OT ban ngày → vào ô 210%', async () => {
    // Cùng ca CA1 nhưng ở lại tới 16:00: ngày đó CÓ OT ban ngày (14:00–16:00),
    // nên khoản 20% nhân với lương giờ 150% chứ không phải 100% → 210%.
    // Gộp hai trường hợp này là trả thiếu 10% trên toàn bộ giờ OT đêm.
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, P01, 'CA1');
      await punch(fromLocal(P01, 4 * 60), 'IN');
      await punch(fromLocal(P01, 16 * 60), 'OUT');
      await computeAttendance(tx, { from: P01, to: P01, employeeCodes: [EMP] });
      return aggregateAttendanceForPayroll(tx, { periodYear: PY, periodMonth: PM });
    });
    const v = r[EMP]!;
    expect(v.otNightNormalWithDayOtHours).toBe(2);
    expect(v.otNightNormalNoDayOtHours).toBe(0);
    // Phần OT ban ngày 14:00–16:00 nằm riêng, không bị gộp vào giờ đêm.
    expect(v.otNormalHours).toBe(2);
  });

  it('giờ đêm KHÔNG bị đếm hai lần: ot*Hours là phần ban ngày, đã trừ đêm', async () => {
    // Bất biến quan trọng nhất của hàm tổng hợp. ot_night_minutes là TẬP CON của
    // ot_weekday_minutes; nếu cả hai cùng vào công thức thì giờ đêm được trả hai
    // lần — một lần ở 150% và một lần ở 210%.
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, P01, 'CA1');
      await punch(fromLocal(P01, 4 * 60), 'IN');
      await punch(fromLocal(P01, 16 * 60), 'OUT');
      await computeAttendance(tx, { from: P01, to: P01, employeeCodes: [EMP] });
      const agg = await aggregateAttendanceForPayroll(tx, { periodYear: PY, periodMonth: PM });
      const raw = await tx
        .select({
          total: sql<number>`(ot_weekday_minutes + ot_weekend_minutes + ot_holiday_minutes)::int`,
          night: dailyAttendance.otNightMinutes,
        })
        .from(dailyAttendance)
        .where(eq(dailyAttendance.employeeCode, EMP));
      return { v: agg[EMP]!, raw: raw[0]! };
    });
    const totalOtHours = r.raw.total / 60;
    const nightOtHours = r.raw.night / 60;
    // Tổng các biến OT ban ngày + OT ban đêm phải đúng bằng tổng OT thô.
    const sumVars =
      r.v.otNormalHours +
      r.v.otWeekendHours +
      r.v.otHolidayHours +
      r.v.otNightNormalWithDayOtHours +
      r.v.otNightNormalNoDayOtHours +
      r.v.otNightWeekendHours +
      r.v.otNightHolidayHours;
    expect(sumVars).toBeCloseTo(totalOtHours, 2);
    expect(nightOtHours).toBeGreaterThan(0);
  });

  it('làm ca đêm ngày lễ → toàn bộ vào ô 390%', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await tx
        .insert(publicHolidays)
        .values({ holidayDate: P02, nameVi: 'Ngày test' })
        .onConflictDoNothing();
      // Lịch vẫn xếp ca đêm vào ngày lễ (xưởng chạy ngày lễ) → mọi giờ là OT 300%,
      // và vì cả ca nằm trong khung đêm nên toàn bộ là OT đêm 390%.
      await roster(tx, P02, 'CA3');
      await punch(fromLocal(P02, 22 * 60), 'IN');
      await punch(fromLocal('2031-03-05', 6 * 60), 'OUT');
      await computeAttendance(tx, { from: P02, to: P02, employeeCodes: [EMP] });
      return aggregateAttendanceForPayroll(tx, { periodYear: PY, periodMonth: PM });
    });
    const v = r[EMP]!;
    expect(v.otNightHolidayHours).toBe(8);
    expect(v.otHolidayHours).toBe(0); // phần ban ngày = 0, không đếm trùng
    // Ngày lễ không có công chính — nếu có thì trả lương hai lần.
    expect(v.workedDays).toBe(0);
  });

  it('mealDays chỉ đếm ngày có làm thật, không đếm ngày nghỉ', async () => {
    const r = await rolled(async (tx) => {
      const punch = await setupDevice(tx);
      await roster(tx, P01, 'HC');
      await roster(tx, P02, 'REST');
      await punch(fromLocal(P01, 8 * 60), 'IN');
      await punch(fromLocal(P01, 17 * 60), 'OUT');
      await computeAttendance(tx, { from: P01, to: P02, employeeCodes: [EMP] });
      return aggregateAttendanceForPayroll(tx, { periodYear: PY, periodMonth: PM });
    });
    const v = r[EMP]!;
    // Phụ cấp ăn giữa ca theo ngày đi làm thật. Mặc định cũ lấy bằng số ngày công
    // chuẩn của tháng nên người nghỉ nửa tháng vẫn lĩnh đủ tiền ăn cả tháng.
    expect(v.mealDays).toBe(1);
    expect(v.workedDays).toBe(1);
  });

  it('không có dữ liệu thì không có khoá — để tầng lương tự quyết định', async () => {
    const r = await rolled(async (tx) => {
      await setupDevice(tx);
      return aggregateAttendanceForPayroll(tx, { periodYear: 2032, periodMonth: 1 });
    });
    // KHÔNG trả {workedDays: 0} cho người không có dữ liệu: 0 ngày công và
    // "chưa chấm công" là hai chuyện khác nhau, và 0 thì vẫn tính ra được một
    // phiếu lương hợp lệ trông như người đó không đi làm ngày nào.
    expect(r[EMP]).toBeUndefined();
  });
});
