/**
 * ============================================================================
 * CHẤM CÔNG NGÀY — nối quẹt thẻ thô, lịch xếp ca và chính sách thành công ngày
 * ============================================================================
 *
 * Ba nguyên tắc chi phối toàn bộ file này:
 *
 * 1. TÍNH LẠI PHẢI RA ĐÚNG SỐ CŨ nếu đầu vào không đổi. `daily_attendance` là
 *    bảng dẫn xuất; bảng nguồn sự thật là `raw_punches`. Vì vậy mọi đầu vào đã
 *    dùng (phiên bản định nghĩa ca, tham số ghép cặp) đều được ghi lại theo dòng.
 *
 * 2. KHÔNG ĐƯỢC IM LẶNG. Quẹt không thuộc ca nào, ngày có lịch mà không có quẹt,
 *    ngày không có lịch mà có quẹt — tất cả phải hiện ra trong kết quả. Một hệ
 *    chấm công bỏ sót im lặng thì ba tháng sau mới phát hiện, lúc đó là tranh
 *    chấp lao động chứ không phải một dòng log.
 *
 * 3. NGÀY LỖI KHÔNG ĐƯỢC KÉO SẬP CẢ ĐỢT. Một nhân viên có lịch trỏ tới mã ca
 *    không tồn tại là lỗi CỦA DÒNG ĐÓ; nếu ném ra ngoài thì 35 người còn lại
 *    không được tính và không ai biết vì sao.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import {
  dailyAttendance,
  employeeShifts,
  publicHolidays,
  rawPunches,
} from '@/db/schema';
import type { Db } from '@/db/client';
import {
  AttendanceError,
  DEFAULT_PAIRING_CONFIG,
  pairPunches,
  punchToAbsMinute,
  type AttendanceResult,
  type AttendanceStatus,
  type CalendarDayKind,
  type PairingConfig,
  type PunchLike,
} from '@/engine/attendance';
import {
  absToCalendar,
  resolveRotationShiftCode,
  resolveShift,
  ShiftError,
  type ResolvedShift,
  type RotationDef,
} from '@/engine/shift';
import { addDays, formatTimeOfDay, fromLocal, MIN_PER_DAY, toLocalMoment } from '@/engine/time';
import { PolicyError, resolvePolicy } from '@/policy/registry';
import { rotationParamsSchema, type RotationParams } from '@/policy/rotation-params';
import { shiftParamsSchema, type ShiftParams } from '@/policy/shift-params';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Chặn một đợt tính quá dài: 92 ngày × 1.000 nhân viên đã là 92.000 dòng. */
export const MAX_RANGE_DAYS = 92;

export class AttendanceServiceError extends Error {
  constructor(
    readonly code: 'BAD_RANGE' | 'NO_EMPLOYEES',
    message: string,
  ) {
    super(message);
    this.name = 'AttendanceServiceError';
  }
}

export interface ComputeOptions {
  /** Ngày đầu, 'YYYY-MM-DD' (tính cả ngày này) */
  from: string;
  /** Ngày cuối, 'YYYY-MM-DD' (tính cả ngày này) */
  to: string;
  /** Không khai thì tính mọi nhân viên có lịch trong khoảng. */
  employeeCodes?: string[];
  /** Ghi đè tham số ghép cặp. Không khai thì dùng mặc định. */
  pairing?: Partial<PairingConfig>;
}

export interface AttendanceComputeSummary {
  from: string;
  to: string;
  /** Số dòng (nhân viên × ngày) đã xử lý */
  daysProcessed: number;
  /** Số dòng đã ghi vào daily_attendance */
  rowsWritten: number;
  byStatus: Record<string, number>;
  /** Tổng phút theo từng loại — để đối chiếu nhanh với bảng lương. */
  totals: {
    workedMinutes: number;
    nightMinutes: number;
    otWeekdayMinutes: number;
    otWeekendMinutes: number;
    otHolidayMinutes: number;
    otNightMinutes: number;
    standardDays: number;
  };
  /**
   * Quẹt không thuộc ngày công nào: không nằm trong cửa sổ ca nào của người đó,
   * và ngày lịch của nó cũng không tồn tại. Đây là mục HR phải xem đầu tiên.
   */
  orphanPunches: { employeeCode: string; punchedAt: string; localDate: string }[];
  /** Lỗi từng dòng — dòng đó bị bỏ qua, các dòng khác vẫn tính. */
  errors: { employeeCode: string; workDate: string; code: string; message: string }[];
}

interface PunchRow {
  employeeCode: string;
  punchedAt: Date;
  direction: string | null;
  /** Ngày lịch theo giờ VN — không phải ngày UTC của timestamp. */
  localDate: string;
  localMinutes: number;
}

// ---------------------------------------------------------------------------
// Bộ nhớ tạm phân giải chính sách
// ---------------------------------------------------------------------------

/**
 * `resolvePolicy` truy vấn DB mỗi lần gọi. Với 12 nhân viên × 30 ngày × 2 loại
 * chính sách thì đó là hàng trăm truy vấn cho CÙNG MỘT câu trả lời. Cache theo
 * (kind, mã, ngày) — và cache cả KẾT QUẢ LỖI, vì một mã ca thiếu định nghĩa thì
 * thiếu cho mọi nhân viên trong ngày đó, không lý do gì hỏi lại 12 lần.
 */
class PolicyCache {
  private shifts = new Map<string, ResolvedShift & { versionId: string } | Error>();
  private rotations = new Map<string, RotationDef | Error>();

  constructor(private readonly db: Db) {}

  async shift(code: string, onDate: string) {
    const key = `${code}@${onDate}`;
    const hit = this.shifts.get(key);
    if (hit) {
      if (hit instanceof Error) throw hit;
      return hit;
    }
    let resolved: (ResolvedShift & { versionId: string }) | Error;
    try {
      const pol = await resolvePolicy<ShiftParams>(
        'SHIFT',
        onDate,
        shiftParamsSchema,
        this.db,
        code,
      );
      const p = pol.params;
      resolved = {
        ...resolveShift(
          {
            code: p.regimeCode,
            name: p.regimeLabel,
            type: p.shiftType,
            nightStart: p.nightStart,
            nightEnd: p.nightEnd,
            segments: p.segments,
          },
          onDate,
        ),
        versionId: pol.versionId,
      };
    } catch (e) {
      // Giữ nguyên lỗi gốc để tầng trên còn đọc được `code`.
      resolved = e instanceof ShiftError || e instanceof PolicyError ? e : new Error(String(e));
    }
    this.shifts.set(key, resolved);
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }

  async rotation(code: string, onDate: string): Promise<RotationDef> {
    const key = `${code}@${onDate}`;
    const hit = this.rotations.get(key);
    if (hit) {
      if (hit instanceof Error) throw hit;
      return hit;
    }
    let resolved: RotationDef | Error;
    try {
      const pol = await resolvePolicy<RotationParams>(
        'SHIFT_ROTATION',
        onDate,
        rotationParamsSchema,
        this.db,
        code,
      );
      const p = pol.params;
      resolved = {
        code: p.regimeCode,
        name: p.regimeLabel,
        cycleLength: p.cycleLength,
        pattern: p.pattern,
        restCode: p.restCode,
        phaseStep: p.phaseStep,
        teamCount: p.teamCount,
      };
    } catch (e) {
      resolved = e instanceof PolicyError ? e : new Error(String(e));
    }
    this.rotations.set(key, resolved);
    if (resolved instanceof Error) throw resolved;
    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Gán quẹt vào ngày công
// ---------------------------------------------------------------------------

/**
 * Cửa sổ nhận quẹt của một ngày: khoảng kế hoạch nới ra theo tham số ghép cặp.
 * Nới đúng bằng `windowBeforeMin`/`windowAfterMin` để nhất quán với cái mà
 * `pairPunches` coi là "thuộc ca này".
 */
function dayWindow(shift: ResolvedShift, cfg: PairingConfig): [number, number] {
  const starts = shift.segments.map((s) => s.absStart);
  const ends = shift.segments.map((s) => s.absEnd);
  return [
    Math.min(...starts) - cfg.windowBeforeMin,
    Math.max(...ends) + cfg.windowAfterMin,
  ];
}

/** Khoảng cách từ một điểm tới một đoạn — 0 nếu nằm trong đoạn. */
function distanceToInterval(x: number, lo: number, hi: number): number {
  if (x < lo) return lo - x;
  if (x > hi) return x - hi;
  return 0;
}

/**
 * Một quẹt thuộc về ngày công nào?
 *
 * Bài toán thật: quẹt lúc 06:00 sáng 16/09 là giờ RA của ca đêm 15/09, hay giờ
 * VÀO của ca sáng 16/09? Cả hai đều hợp lý nếu chỉ nhìn một quẹt. Quy tắc:
 *
 *   1. Ngày nào có ca mà quẹt NẰM TRONG CỬA SỔ thì ứng viên là ngày đó.
 *   2. Nhiều ngày cùng nhận → ngày có khoảng kế hoạch GẦN quẹt nhất thắng; hoà
 *      thì lấy ngày sớm hơn.
 *   3. Không ngày nào nhận → quẹt thuộc NGÀY LỊCH CỦA CHÍNH NÓ (theo giờ VN).
 *      Đây là nhánh cho ngày nghỉ/ngày lễ: không có ca kế hoạch nên không có
 *      cửa sổ, nhưng quẹt vẫn có ý nghĩa (làm thêm ngày nghỉ).
 *
 * Trả về map ngày → danh sách quẹt, kèm tập quẹt mồ côi.
 */
function assignPunches(
  punches: PunchRow[],
  daysByEmployee: Map<string, Map<string, { shift: ResolvedShift | null; cfg: PairingConfig }>>,
  cfg: PairingConfig,
): { byDay: Map<string, PunchLike[]>; orphans: PunchRow[] } {
  const byDay = new Map<string, PunchLike[]>();
  const orphans: PunchRow[] = [];
  const push = (key: string, p: PunchLike) => {
    const arr = byDay.get(key);
    if (arr) arr.push(p);
    else byDay.set(key, [p]);
  };

  for (const p of punches) {
    const days = daysByEmployee.get(p.employeeCode);
    if (!days) {
      orphans.push(p);
      continue;
    }

    let best: { key: string; dist: number } | null = null;
    for (const [workDate, day] of days) {
      if (!day.shift) continue; // ngày nghỉ/lễ không có cửa sổ — xử lý ở nhánh 3
      const [lo, hi] = dayWindow(day.shift, day.cfg);
      const abs = punchToAbsMinute({ date: p.localDate, minutes: p.localMinutes }, workDate);
      if (abs < lo || abs > hi) continue;
      const starts = day.shift.segments.map((s) => s.absStart);
      const ends = day.shift.segments.map((s) => s.absEnd);
      const dist = distanceToInterval(
        abs,
        Math.min(...starts),
        Math.max(...ends),
      );
      // `<=` chứ không phải `<`: hoà thì giữ ngày đã xét trước, và vòng lặp đi
      // theo thứ tự ngày tăng dần nên "giữ cái trước" chính là "lấy ngày sớm hơn".
      if (best === null || dist < best.dist) best = { key: `${p.employeeCode}|${workDate}`, dist };
    }

    if (best) {
      push(best.key, { absMinute: punchToAbsMinute(
        { date: p.localDate, minutes: p.localMinutes },
        best.key.split('|')[1]!,
      )});
      continue;
    }

    // Nhánh 3: không ca nào nhận. Nếu có dòng lịch cho đúng ngày lịch của quẹt
    // thì gán vào đó (ngày nghỉ có người đi làm = OT ngày nghỉ).
    if (days.has(p.localDate)) {
      push(`${p.employeeCode}|${p.localDate}`, {
        absMinute: punchToAbsMinute({ date: p.localDate, minutes: p.localMinutes }, p.localDate),
      });
    } else {
      orphans.push(p);
    }
  }
  void cfg;
  return { byDay, orphans };
}

// ---------------------------------------------------------------------------
// Hàm chính
// ---------------------------------------------------------------------------

export async function computeAttendance(
  db: Db,
  opts: ComputeOptions,
): Promise<AttendanceComputeSummary> {
  const { from, to } = opts;
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    throw new AttendanceServiceError('BAD_RANGE', `Ngày phải theo dạng YYYY-MM-DD, nhận ${from}..${to}`);
  }
  if (from > to) {
    throw new AttendanceServiceError('BAD_RANGE', `from (${from}) phải <= to (${to})`);
  }
  // Số ngày tính cả hai đầu. So với giới hạn trước khi nhân lên, không phải sau.
  const spanDays =
    Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
  if (spanDays > MAX_RANGE_DAYS) {
    throw new AttendanceServiceError(
      'BAD_RANGE',
      `Khoảng ${spanDays} ngày vượt giới hạn ${MAX_RANGE_DAYS} ngày một đợt tính`,
    );
  }

  const cfg: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, ...(opts.pairing ?? {}) };
  const cache = new PolicyCache(db);

  // --- Lịch ---------------------------------------------------------------
  const rosterFilters = [
    gte(employeeShifts.workDate, from),
    lte(employeeShifts.workDate, to),
  ];
  if (opts.employeeCodes?.length) rosterFilters.push(inArray(employeeShifts.employeeCode, opts.employeeCodes));
  // KHÔNG trả về sớm khi lịch rỗng.
  //
  // Bản đầu tiên có `if (roster.length === 0) return emptySummary(...)` cho gọn,
  // và nó nuốt đúng cái chẩn đoán mà hàm này hứa hẹn: một lô quẹt của người
  // chưa được xếp ca sẽ biến mất hoàn toàn thay vì hiện ra trong orphanPunches.
  // "Không có lịch" không có nghĩa là "không có gì để báo" — nó thường có nghĩa
  // là quên xếp ca, và đó là việc HR phải biết.
  const roster = await db.select().from(employeeShifts).where(and(...rosterFilters));

  // --- Ngày lễ ------------------------------------------------------------
  // Lấy dư một ngày ở mỗi đầu: ca đêm của ngày `to` kết thúc vào sáng hôm sau.
  const holidays = await db
    .select({ holidayDate: publicHolidays.holidayDate })
    .from(publicHolidays)
    .where(
      and(gte(publicHolidays.holidayDate, addDays(from, -1)), lte(publicHolidays.holidayDate, addDays(to, 1))),
    );
  const holidaySet = new Set(holidays.map((h) => h.holidayDate));

  // --- Resolve ca cho từng dòng lịch --------------------------------------
  // Làm trước khi đọc quẹt, vì cửa sổ nhận quẹt phụ thuộc vào ca đã resolve.
  const daysByEmployee = new Map<string, Map<string, { shift: ResolvedShift | null; cfg: PairingConfig }>>();
  const errors: AttendanceComputeSummary['errors'] = [];
  /** Dòng lịch đã resolve thành công, chờ tính. */
  const pending: {
    employeeCode: string;
    workDate: string;
    shiftCode: string;
    shift: ResolvedShift | null;
    versionId: string | null;
    dayKind: CalendarDayKind;
  }[] = [];

  for (const row of roster) {
    const { employeeCode, workDate } = row;
    try {
      let shiftCode: string | null;
      let shift: ResolvedShift | null = null;
      let versionId: string | null = null;

      if (row.rotationCode) {
        if (row.anchorDate === null || row.teamIndex === null) {
          throw new AttendanceServiceError(
            'BAD_RANGE',
            'lịch ca xoay thiếu anchorDate/teamIndex',
          );
        }
        const rot = await cache.rotation(row.rotationCode, workDate);
        shiftCode = resolveRotationShiftCode(workDate, row.anchorDate, row.teamIndex, rot);
      } else {
        shiftCode = row.shiftCode;
      }

      const isRest = shiftCode === null || shiftCode === 'REST';
      let dayKind: CalendarDayKind;
      if (holidaySet.has(workDate)) dayKind = 'PUBLIC_HOLIDAY';
      else if (row.leaveKind === 'PAID_LEAVE') dayKind = 'PAID_LEAVE';
      else if (isRest) dayKind = 'WEEKLY_REST';
      else dayKind = 'WORKING_DAY';

      // Ngày lễ/ngày nghỉ vẫn cần biết ca để tính OT — nhưng ca của ngày nghỉ thì
      // không tồn tại. Xử lý ở dưới bằng ca tổng hợp, không phải ở đây.
      if (!isRest && dayKind === 'WORKING_DAY') {
        const s = await cache.shift(shiftCode!, workDate);
        shift = s;
        versionId = s.versionId;
      } else if (!isRest) {
        // Ngày lễ mà lịch vẫn xếp ca: dùng ca đó làm khoảng tham chiếu cho OT.
        const s = await cache.shift(shiftCode!, workDate);
        shift = s;
        versionId = s.versionId;
      }

      if (!daysByEmployee.has(employeeCode)) daysByEmployee.set(employeeCode, new Map());
      daysByEmployee.get(employeeCode)!.set(workDate, { shift, cfg });
      pending.push({ employeeCode, workDate, shiftCode: shiftCode ?? 'REST', shift, versionId, dayKind });
    } catch (e) {
      errors.push(toError(employeeCode, workDate, e));
    }
  }

  // --- Quẹt thô -----------------------------------------------------------
  // Lấy dư một ngày ở mỗi đầu vì ca đêm vắt 0h: quẹt 06:00 sáng 16/09 thuộc về
  // ngày công 15/09, và nếu chỉ lấy đúng khoảng [from, to] thì quẹt đó biến mất
  // và ca đêm thành "thiếu quẹt ra" cho đúng ngày khó tính nhất trong hệ thống.
  const punchRows = await db
    .select({
      employeeCode: rawPunches.employeeCode,
      punchedAt: rawPunches.punchedAt,
      direction: rawPunches.direction,
    })
    .from(rawPunches)
    .where(
      and(
        gte(rawPunches.punchedAt, fromLocal(addDays(from, -1), 0)),
        lte(rawPunches.punchedAt, fromLocal(addDays(to, 1), MIN_PER_DAY - 1)),
        ...(opts.employeeCodes?.length ? [inArray(rawPunches.employeeCode, opts.employeeCodes)] : []),
      ),
    )
    .orderBy(rawPunches.punchedAt);

  const punches: PunchRow[] = punchRows.map((r) => {
    const m = toLocalMoment(r.punchedAt);
    return {
      employeeCode: r.employeeCode,
      punchedAt: r.punchedAt,
      direction: r.direction,
      localDate: m.date,
      localMinutes: m.minutes,
    };
  });

  const { byDay, orphans } = assignPunches(punches, daysByEmployee, cfg);

  // --- Tính từng ngày -----------------------------------------------------
  const byStatus: Record<string, number> = {};
  const totals = {
    workedMinutes: 0,
    nightMinutes: 0,
    otWeekdayMinutes: 0,
    otWeekendMinutes: 0,
    otHolidayMinutes: 0,
    otNightMinutes: 0,
    standardDays: 0,
  };
  let rowsWritten = 0;

  for (const day of pending) {
    const key = `${day.employeeCode}|${day.workDate}`;
    const dayPunches = byDay.get(key) ?? [];
    try {
      let result: AttendanceResult;
      let usedVersionId = day.versionId;

      if (day.shift) {
        result = pairPunches(day.shift, dayPunches, day.dayKind, cfg);
      } else {
        // Ngày nghỉ / ngày lễ không có ca: khoảng làm việc là TỪ QUẸT ĐẦU ĐẾN
        // QUẸT CUỐI. Không có ca kế hoạch thì không có giờ nghỉ nào để trừ, và
        // mọi phút đều là OT.
        if (dayPunches.length === 0) {
          result = restDayResult(day.dayKind);
        } else {
          const mins = dayPunches.map((p) => p.absMinute);
          const lo = Math.min(...mins);
          const hi = Math.max(...mins);
          if (hi === lo) {
            // Một quẹt duy nhất trong ngày nghỉ: không có khoảng nào để tính OT.
            // Không được im lặng — một quẹt lẻ là dấu hiệu máy hỏng hoặc quên quẹt.
            result = restDayResult(day.dayKind);
            result.warnings.push(
              `Ngày không xếp ca nhưng có đúng 1 quẹt lúc ${formatTimeOfDay(lo)} — không tính được OT, cần HR xác nhận.`,
            );
          } else {
            result = pairPunches(
              syntheticShift(day.workDate, lo, hi),
              dayPunches,
              day.dayKind,
              cfg,
            );
          }
        }
      }

      await db
        .insert(dailyAttendance)
        .values(toRow(day, result, cfg, usedVersionId))
        .onConflictDoUpdate({
          target: [dailyAttendance.employeeCode, dailyAttendance.workDate],
          set: toRow(day, result, cfg, usedVersionId),
        });

      rowsWritten += 1;
      byStatus[result.status] = (byStatus[result.status] ?? 0) + 1;
      totals.workedMinutes += result.workedMinutes;
      totals.nightMinutes += result.nightMinutes;
      totals.otWeekdayMinutes += result.otWeekdayMinutes;
      totals.otWeekendMinutes += result.otWeekendMinutes;
      totals.otHolidayMinutes += result.otHolidayMinutes;
      totals.otNightMinutes += result.otNightMinutes;
      totals.standardDays += result.standardDays;
    } catch (e) {
      errors.push(toError(day.employeeCode, day.workDate, e));
    }
  }

  return {
    from,
    to,
    daysProcessed: pending.length,
    rowsWritten,
    byStatus,
    totals,
    orphanPunches: orphans.map((o) => ({
      employeeCode: o.employeeCode,
      punchedAt: o.punchedAt.toISOString(),
      localDate: o.localDate,
    })),
    errors,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toError(employeeCode: string, workDate: string, e: unknown) {
  const code =
    e instanceof AttendanceError || e instanceof ShiftError || e instanceof PolicyError
      ? e.code
      : e instanceof Error
        ? 'UNEXPECTED'
        : 'UNEXPECTED';
  return {
    employeeCode,
    workDate,
    code,
    message: e instanceof Error ? e.message : String(e),
  };
}

/**
 * Ca tổng hợp phủ đúng khoảng [lo, hi] — dùng cho ngày nghỉ có người đi làm.
 *
 * Đi qua `resolveShift` chứ KHÔNG tự dựng object: `ResolvedShift` có hơn chục
 * trường bất biến (nightMinutes từng đoạn, crossMidnight, standardDays…). Tự dựng
 * thì hôm nay đủ, ba tháng sau engine thêm một trường là object này thiếu mà
 * không có lỗi nào báo — cho tới khi một phép tính đọc trường đó.
 *
 * Không có `breakMinutes`: ngày nghỉ không có ca kế hoạch nên cũng không có giờ
 * nghỉ kế hoạch nào để trừ. Trừ một giờ nghỉ tưởng tượng khỏi OT ngày lễ là bớt
 * tiền của người ta dựa trên một con số không nằm trong thoả thuận nào.
 */
function syntheticShift(workDate: string, lo: number, hi: number): ResolvedShift {
  if (hi <= lo) {
    throw new AttendanceServiceError(
      'BAD_RANGE',
      `syntheticShift cần hi > lo, nhận ${lo}..${hi}`,
    );
  }
  return resolveShift(
    {
      code: 'OT_REFERENCE',
      name: 'Khoảng làm việc thực tế (ngày không xếp ca)',
      type: 'OFFICE',
      segments: [
        {
          name: 'Thực tế',
          start: formatTimeOfDay(lo),
          end: formatTimeOfDay(hi),
        },
      ],
    },
    workDate,
  );
}

/**
 * Kết quả cho ngày không xếp ca và không có (đủ) quẹt.
 *
 * Viết tay thay vì gọi `pairPunches` với một ca rỗng, vì một đoạn 0 phút sẽ bị
 * `resolveShift` từ chối (giờ nghỉ >= thời lượng đoạn). Có test `restDayResult
 * khớp pairPunches` để hai đường này không lệch nhau.
 */
function restDayResult(dayKind: CalendarDayKind): AttendanceResult {
  const status: AttendanceStatus =
    dayKind === 'PUBLIC_HOLIDAY' ? 'HOLIDAY_OFF' : dayKind === 'PAID_LEAVE' ? 'LEAVE_PAID' : 'WEEKLY_OFF';
  return {
    status,
    segments: [],
    checkInAbs: null,
    checkOutAbs: null,
    workedMinutes: 0,
    workedHours: 0,
    standardDays: 0,
    nightMinutes: 0,
    nightHours: 0,
    lateMinutes: 0,
    earlyLeaveMinutes: 0,
    absentMinutes: 0,
    otWeekdayMinutes: 0,
    otWeekendMinutes: 0,
    otHolidayMinutes: 0,
    otNightMinutes: 0,
    regularizedMinutes: 0,
    warnings: [],
    rejectedPunches: [],
  };
}

function toRow(
  day: { employeeCode: string; workDate: string; shiftCode: string; dayKind: CalendarDayKind },
  r: AttendanceResult,
  cfg: PairingConfig,
  versionId: string | null,
) {
  return {
    employeeCode: day.employeeCode,
    workDate: day.workDate,
    shiftCode: day.shiftCode,
    shiftPolicyVersionId: versionId,
    dayKind: day.dayKind,
    status: r.status,
    workedMinutes: r.workedMinutes,
    // numeric trong DB, string trong Drizzle — chuyển đổi ở ĐÚNG MỘT chỗ này.
    standardDays: r.standardDays.toFixed(3),
    nightMinutes: r.nightMinutes,
    lateMinutes: r.lateMinutes,
    earlyLeaveMinutes: r.earlyLeaveMinutes,
    absentMinutes: r.absentMinutes,
    otWeekdayMinutes: r.otWeekdayMinutes,
    otWeekendMinutes: r.otWeekendMinutes,
    otHolidayMinutes: r.otHolidayMinutes,
    otNightMinutes: r.otNightMinutes,
    regularizedMinutes: r.regularizedMinutes,
    punchCount: r.segments.reduce(
      (n, s) => n + (s.inSource === 'PUNCH' ? 1 : 0) + (s.outSource === 'PUNCH' ? 1 : 0),
      0,
    ),
    checkInAt: r.checkInAbs === null ? null : absTime(day.workDate, r.checkInAbs),
    checkOutAt: r.checkOutAbs === null ? null : absTime(day.workDate, r.checkOutAbs),
    segments: r.segments,
    rejectedPunches: r.rejectedPunches,
    warnings: r.warnings,
    // Chỉ giữ các trường SỐ: tham số ghép cặp toàn số, và ghi lại nó là để ba
    // tháng sau còn biết ngày đó được tính bằng ngưỡng nào.
    pairingConfig: {
      graceMinutes: cfg.graceMinutes,
      windowBeforeMin: cfg.windowBeforeMin,
      windowAfterMin: cfg.windowAfterMin,
      earlyLeaveToleranceMin: cfg.earlyLeaveToleranceMin,
      halfDayAfterLateMin: cfg.halfDayAfterLateMin,
      absentAfterLateMin: cfg.absentAfterLateMin,
      standardDayHours: cfg.standardDayHours,
      halfDayWorkedRatio: cfg.halfDayWorkedRatio,
      dailyOtWarningHours: cfg.dailyOtWarningHours,
      otWarningThresholdMin: cfg.otWarningThresholdMin,
    },
    computedAt: new Date(),
  };
}

/** Phút tuyệt đối (có thể > 1440 với ca đêm) → thời điểm thật có múi giờ. */
function absTime(workDate: string, absMinute: number): Date {
  const { date, minutes } = absToCalendar(workDate, absMinute);
  return fromLocal(date, minutes);
}

// ---------------------------------------------------------------------------
// TỔNG HỢP CHO KỲ LƯƠNG
// ---------------------------------------------------------------------------

/**
 * Biến chấm công cho một nhân viên trong một kỳ lương.
 *
 * TÁCH PHẦN ĐÊM RA KHỎI PHẦN BAN NGÀY là điểm mấu chốt của interface này.
 * `ot_night_minutes` là TẬP CON của `ot_weekday/weekend/holiday_minutes` — nếu đưa
 * cả hai vào công thức lương thì giờ đêm bị trả HAI LẦN (một lần ở 150% và một
 * lần ở 210%). Nên các biến `ot*Hours` ở đây là phần BAN NGÀY, đã trừ phần đêm.
 */
export interface PayrollAttendanceVars {
  /** Tổng ngày công quy chuẩn (Σ standard_days) — mẫu số của lương cơ bản. */
  workedDays: number;
  /** Số ngày có làm việc thật — cơ sở phụ cấp ăn giữa ca. */
  mealDays: number;
  /** Số ngày đi trễ quá grace. */
  lateCount: number;
  absentDays: number;
  /** Giờ làm việc rơi vào khung đêm (phụ cấp 30%, Điều 98 khoản 2). */
  nightHours: number;

  // --- OT BAN NGÀY (đã trừ phần đêm) -----------------------------------
  otNormalHours: number;
  otWeekendHours: number;
  otHolidayHours: number;

  // --- OT BAN ĐÊM, tách theo Điều 57 NĐ 145/2020 -----------------------
  /**
   * OT đêm ngày thường, NGÀY ĐÓ CÓ OT ban ngày → 210%.
   *   150% + 30% + 20% × 150% = 210%
   */
  otNightNormalWithDayOtHours: number;
  /**
   * OT đêm ngày thường, ngày đó KHÔNG có OT ban ngày → 200%.
   *   150% + 30% + 20% × 100% = 200%
   *
   * Khoản 20% nhân với "tiền lương giờ vào ban ngày của ngày tương ứng", và con
   * số đó là 100% hay 150% tuỳ ngày đó đã có OT ban ngày hay chưa. Gộp hai
   * trường hợp thành một hệ số là trả sai — lệch 10% trên toàn bộ giờ OT đêm.
   */
  otNightNormalNoDayOtHours: number;
  /** OT đêm ngày nghỉ hằng tuần → 270% = 200 + 30 + 20×200. */
  otNightWeekendHours: number;
  /** OT đêm ngày lễ, tết → 390% = 300 + 30 + 20×300. */
  otNightHolidayHours: number;
}

/**
 * Tổng hợp `daily_attendance` thành biến lương cho một kỳ.
 *
 * Đọc từ bảng DẪN XUẤT chứ không tính lại từ quẹt thô: công ngày đã được tính và
 * (về nguyên tắc) đã được nhân sự rà soát. Tính lại ở đây thì hai chỗ có thể cho
 * hai con số khác nhau, và bảng lương sẽ không khớp với trang chấm công.
 */
export async function aggregateAttendanceForPayroll(
  db: Db,
  opts: { periodYear: number; periodMonth: number; employeeCodes?: string[] },
): Promise<Record<string, PayrollAttendanceVars>> {
  const { periodYear, periodMonth } = opts;
  const ym = `${periodYear}-${String(periodMonth).padStart(2, '0')}`;
  const from = `${ym}-01`;
  const lastDay = new Date(Date.UTC(periodYear, periodMonth, 0)).getUTCDate();
  const to = `${ym}-${String(lastDay).padStart(2, '0')}`;

  // "OT ban ngày" của một dòng = tổng OT trừ phần đêm. Dùng biểu thức này ở cả
  // bốn nhánh để không chỗ nào quên trừ và trả trùng giờ đêm.
  const dayOt = sql`(${dailyAttendance.otWeekdayMinutes} + ${dailyAttendance.otWeekendMinutes} + ${dailyAttendance.otHolidayMinutes} - ${dailyAttendance.otNightMinutes})`;

  const conds = [gte(dailyAttendance.workDate, from), lte(dailyAttendance.workDate, to)];
  if (opts.employeeCodes?.length) {
    conds.push(inArray(dailyAttendance.employeeCode, opts.employeeCodes));
  }

  const rows = await db
    .select({
      employeeCode: dailyAttendance.employeeCode,
      workedDays: sql<number>`coalesce(sum(${dailyAttendance.standardDays}),0)::float`,
      mealDays: sql<number>`count(*) filter (where ${dailyAttendance.workedMinutes} > 0)::int`,
      lateCount: sql<number>`count(*) filter (where ${dailyAttendance.lateMinutes} > 0)::int`,
      absentDays: sql<number>`count(*) filter (where ${dailyAttendance.status} = 'ABSENT')::int`,
      nightHours: sql<number>`coalesce(sum(${dailyAttendance.nightMinutes}),0)::float / 60`,
      otNormal: sql<number>`coalesce(sum(${dayOt}) filter (where ${dailyAttendance.dayKind} = 'WORKING_DAY'),0)::float / 60`,
      otWeekend: sql<number>`coalesce(sum(${dayOt}) filter (where ${dailyAttendance.dayKind} = 'WEEKLY_REST'),0)::float / 60`,
      otHoliday: sql<number>`coalesce(sum(${dayOt}) filter (where ${dailyAttendance.dayKind} = 'PUBLIC_HOLIDAY'),0)::float / 60`,
      otNightWithDay: sql<number>`coalesce(sum(${dailyAttendance.otNightMinutes}) filter (
        where ${dailyAttendance.dayKind} = 'WORKING_DAY' and ${dayOt} > 0),0)::float / 60`,
      otNightNoDay: sql<number>`coalesce(sum(${dailyAttendance.otNightMinutes}) filter (
        where ${dailyAttendance.dayKind} = 'WORKING_DAY' and ${dayOt} <= 0),0)::float / 60`,
      otNightWeekend: sql<number>`coalesce(sum(${dailyAttendance.otNightMinutes}) filter (
        where ${dailyAttendance.dayKind} = 'WEEKLY_REST'),0)::float / 60`,
      otNightHoliday: sql<number>`coalesce(sum(${dailyAttendance.otNightMinutes}) filter (
        where ${dailyAttendance.dayKind} = 'PUBLIC_HOLIDAY'),0)::float / 60`,
    })
    .from(dailyAttendance)
    .where(and(...conds))
    .groupBy(dailyAttendance.employeeCode);

  const out: Record<string, PayrollAttendanceVars> = {};
  for (const r of rows) {
    out[r.employeeCode] = {
      // Làm tròn về 2 chữ số thập phân: phút lẻ chia 60 ra số vô hạn, và để nguyên
      // thì lương mỗi lần chạy có thể lệch một đồng vì thứ tự cộng dấu phẩy động.
      workedDays: round2(r.workedDays),
      mealDays: r.mealDays,
      lateCount: r.lateCount,
      absentDays: r.absentDays,
      nightHours: round2(r.nightHours),
      otNormalHours: round2(r.otNormal),
      otWeekendHours: round2(r.otWeekend),
      otHolidayHours: round2(r.otHoliday),
      otNightNormalWithDayOtHours: round2(r.otNightWithDay),
      otNightNormalNoDayOtHours: round2(r.otNightNoDay),
      otNightWeekendHours: round2(r.otNightWeekend),
      otNightHolidayHours: round2(r.otNightHoliday),
    };
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
