/**
 * ============================================================================
 * RESOLVE CA KÍP — ca hành chính, ca đêm vắt 0h, ca gãy, xoay 3 ca 4 kíp
 * ============================================================================
 *
 * Mô hình: một ca gồm 1..N ĐOẠN (segment). Mỗi đoạn có giờ vào, giờ ra, và
 * `endDayOffset` = 1 nếu giờ ra thuộc ngày hôm sau.
 *
 *   Hành chính : 1 đoạn 08:00 → 17:00, nghỉ trưa 60'
 *   Ca gãy     : 2 đoạn 08:00→12:00 và 14:00→18:00
 *   Ca đêm     : 1 đoạn 22:00 → 06:00 (+1 ngày)   ← CROSS-MIDNIGHT
 *   3 ca 4 kíp : CA1 06:00→14:00, CA2 14:00→22:00, CA3 22:00→06:00(+1)
 *
 * Mọi thời điểm quy về PHÚT TUYỆT ĐỐI so với 00:00 của ngày công vụ, nên so sánh
 * và ghép cặp không bao giờ nhầm khi qua 0h. Đó là toàn bộ lý do file này tồn tại:
 * làm việc trực tiếp với Date thì ca đêm là một nguồn bug vô tận.
 *
 * Định nghĩa ca là DỮ LIỆU (policy kind SHIFT), không phải code — nhà máy đổi giờ
 * vào ca là chuyện hàng tháng.
 */

import {
  MIN_PER_DAY,
  addDays,
  diffDays,
  formatTimeOfDay,
  overlapMinutes,
  parseTimeOfDay,
} from './time.js';

export class ShiftError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ShiftError';
    this.code = code;
  }
}

export interface ShiftSegmentDef {
  name: string;
  /** "HH:mm" */
  start: string;
  /** "HH:mm" — nhỏ hơn hoặc bằng start thì tự hiểu là qua ngày hôm sau */
  end: string;
  /** Ghi đè tường minh: 1 = giờ ra thuộc ngày kế tiếp */
  endDayOffset?: number;
  /** Giờ nghỉ giữa đoạn (phút) — trừ khỏi giờ công */
  breakMinutes?: number;
  /**
   * Khung giờ nghỉ ("HH:mm"). Khai cái này thì giờ nghỉ chỉ bị trừ khi người ta
   * THẬT SỰ làm việc vắt qua khung đó.
   *
   * Chỉ có `breakMinutes` mà không có khung thì engine buộc phải trừ trọn, và
   * người làm 08:00–11:00 (chưa hề nghỉ trưa) vẫn bị trừ 60 phút — 3 giờ làm chỉ
   * còn 2 giờ công.
   */
  breakStart?: string;
  breakEnd?: string;
}

export type ShiftType = 'OFFICE' | 'NIGHT_CROSS_DAY' | 'SPLIT' | 'ROTATING' | 'FLEXIBLE';

export interface ShiftDef {
  code: string;
  name: string;
  type: ShiftType;
  segments: ShiftSegmentDef[];
  /** Khung giờ đêm pháp lý. Mặc định 22:00 → 06:00 (Điều 106 BLLĐ 2019). */
  nightStart?: string;
  nightEnd?: string;
  /** Số giờ công chuẩn của ca. Null/undefined = tự tính từ các đoạn. */
  standardHours?: number | null;
}

export interface ResolvedSegment {
  index: number;
  name: string;
  startMin: number;
  endMin: number;
  endDayOffset: number;
  /** Phút tuyệt đối so với 00:00 ngày workDate */
  absStart: number;
  absEnd: number;
  breakMinutes: number;
  /** Khung giờ nghỉ tuyệt đối; null khi định nghĩa chỉ cho thời lượng. */
  breakAbsStart: number | null;
  breakAbsEnd: number | null;
  /** Phút công thực của đoạn (đã trừ nghỉ) */
  netMinutes: number;
  /** Phút của đoạn rơi vào khung giờ đêm */
  nightMinutes: number;
  isNightSegment: boolean;
  startClock: string;
  endClock: string;
}

export interface ResolvedShift {
  code: string;
  name: string;
  type: ShiftType;
  workDate: string;
  segments: ResolvedSegment[];
  absStart: number;
  absEnd: number;
  totalNetMinutes: number;
  totalNetHours: number;
  /** Số công chuẩn quy đổi (1 công = standardDayHours giờ) */
  standardDays: number;
  nightMinutes: number;
  nightHours: number;
  crossMidnight: boolean;
  startDate: string;
  endDate: string;
  nightStartMin: number;
  nightEndMin: number;
}

export const DEFAULT_NIGHT_START = '22:00';
export const DEFAULT_NIGHT_END = '06:00';
export const DEFAULT_STANDARD_DAY_HOURS = 8;

/**
 * Số phút giao giữa khoảng [from, to) (phút tuyệt đối) và khung giờ đêm lặp lại
 * mỗi ngày.
 *
 * Khung 22:00–06:00 được "trải" thành các khoảng tuyệt đối
 * [d*1440 + 1320, d*1440 + 1320 + 480) với d chạy từ ngày trước `from` tới ngày
 * sau `to`. Phải quét thừa ra hai bên vì một ca có thể bắt đầu trước 22:00 ngày
 * D và kết thúc sau 06:00 ngày D+1 — tức chạm tới HAI khoảng đêm.
 */
export function nightOverlapMinutes(
  fromAbs: number,
  toAbs: number,
  nightStartMin: number,
  nightEndMin: number,
): number {
  if (!Number.isFinite(fromAbs) || !Number.isFinite(toAbs)) {
    throw new ShiftError('NOT_A_NUMBER', `Khoảng thời gian không phải số: ${fromAbs}..${toAbs}`);
  }
  if (toAbs <= fromAbs) return 0;

  // Khung đêm vắt qua 0h nên độ dài = (1440 - start) + end.
  // 22:00→06:00 = (1440-1320) + 360 = 480 phút. Đúng 8 tiếng.
  const nightLen = nightEndMin + (MIN_PER_DAY - nightStartMin);
  if (nightLen <= 0 || nightLen >= MIN_PER_DAY) {
    throw new ShiftError(
      'BAD_NIGHT_WINDOW',
      `Khung giờ đêm vô lý: ${formatTimeOfDay(nightStartMin)} → ${formatTimeOfDay(nightEndMin)}`,
    );
  }

  const firstDay = Math.floor(fromAbs / MIN_PER_DAY) - 1;
  const lastDay = Math.floor(toAbs / MIN_PER_DAY) + 1;
  let total = 0;
  for (let d = firstDay; d <= lastDay; d += 1) {
    const nStart = d * MIN_PER_DAY + nightStartMin;
    total += overlapMinutes(fromAbs, toAbs, nStart, nStart + nightLen);
  }
  return total;
}

function resolveSegment(
  def: ShiftSegmentDef,
  index: number,
  nightStartMin: number,
  nightEndMin: number,
): ResolvedSegment {
  const startMin = parseTimeOfDay(def.start);
  const endMin = parseTimeOfDay(def.end);
  let endDayOffset = def.endDayOffset ?? 0;

  // Suy luận: giờ ra <= giờ vào và không khai offset → hiểu là qua ngày hôm sau.
  // Đây là tiện ích, không phải mơ hồ: "22:00 → 06:00" chỉ có một cách hiểu hợp lý.
  if (def.endDayOffset === undefined && endMin <= startMin) endDayOffset = 1;

  // Nhưng nếu NGƯỜI DÙNG khai rõ offset=0 mà giờ ra vẫn không sau giờ vào thì đó
  // là dữ liệu sai, không được tự đoán.
  if (endDayOffset === 0 && endMin <= startMin) {
    throw new ShiftError(
      'SEGMENT_NOT_POSITIVE',
      `Đoạn "${def.name}": giờ ra (${def.end}) không sau giờ vào (${def.start})`,
    );
  }

  const absEndMin = endDayOffset * MIN_PER_DAY + endMin;

  // Khung giờ nghỉ: nếu khai thì suy thời lượng TỪ khung, và kiểm tra khớp với
  // breakMinutes khi cả hai đều có — hai con số mô tả cùng một sự thật nên chúng
  // có thể lệch nhau, và lệch thì phải kêu chứ không được âm thầm chọn một.
  let breakAbsStart: number | null = null;
  let breakAbsEnd: number | null = null;
  let breakMinutes = Math.max(0, def.breakMinutes ?? 0);
  if (def.breakStart !== undefined || def.breakEnd !== undefined) {
    if (def.breakStart === undefined || def.breakEnd === undefined) {
      throw new ShiftError(
        'BREAK_WINDOW_INCOMPLETE',
        `Đoạn "${def.name}": phải khai cả breakStart và breakEnd, không chỉ một`,
      );
    }
    breakAbsStart = parseTimeOfDay(def.breakStart);
    const breakEndMin = parseTimeOfDay(def.breakEnd);
    breakAbsEnd = breakEndMin <= breakAbsStart ? MIN_PER_DAY + breakEndMin : breakEndMin;
    if (breakAbsStart < startMin || breakAbsEnd > absEndMin) {
      throw new ShiftError(
        'BREAK_OUTSIDE_SEGMENT',
        `Đoạn "${def.name}": khung nghỉ ${def.breakStart}–${def.breakEnd} nằm ngoài đoạn giờ`,
      );
    }
    const fromWindow = breakAbsEnd - breakAbsStart;
    if (def.breakMinutes !== undefined && def.breakMinutes !== fromWindow) {
      throw new ShiftError(
        'BREAK_MISMATCH',
        `Đoạn "${def.name}": breakMinutes (${def.breakMinutes}') khác độ dài khung nghỉ ` +
          `${def.breakStart}–${def.breakEnd} (${fromWindow}')`,
      );
    }
    breakMinutes = fromWindow;
  }
  const grossMinutes = absEndMin - startMin;
  if (breakMinutes >= grossMinutes) {
    throw new ShiftError(
      'BREAK_EXCEEDS_SEGMENT',
      `Đoạn "${def.name}": giờ nghỉ (${breakMinutes}') >= thời lượng đoạn (${grossMinutes}')`,
    );
  }
  const nightMinutes = nightOverlapMinutes(startMin, absEndMin, nightStartMin, nightEndMin);

  return {
    index,
    name: def.name,
    startMin,
    endMin,
    endDayOffset,
    absStart: startMin,
    absEnd: absEndMin,
    breakMinutes,
    breakAbsStart,
    breakAbsEnd,
    netMinutes: grossMinutes - breakMinutes,
    nightMinutes,
    isNightSegment: nightMinutes > 0,
    startClock: formatTimeOfDay(startMin),
    endClock: formatTimeOfDay(endMin),
  };
}

/** "Mở" định nghĩa ca thành các khoảng tuyệt đối cho một ngày công vụ. */
export function resolveShift(
  def: ShiftDef,
  workDate: string,
  standardDayHours = DEFAULT_STANDARD_DAY_HOURS,
): ResolvedShift {
  if (!def.segments || def.segments.length === 0) {
    throw new ShiftError('NO_SEGMENTS', `Ca "${def.code}" không có đoạn giờ nào`);
  }
  const nightStartMin = parseTimeOfDay(def.nightStart ?? DEFAULT_NIGHT_START);
  const nightEndMin = parseTimeOfDay(def.nightEnd ?? DEFAULT_NIGHT_END);

  const segments = def.segments.map((seg, i) =>
    resolveSegment(seg, i, nightStartMin, nightEndMin),
  );

  // Sắp theo giờ vào và cấm chồng lấn. Một ca có hai đoạn đè lên nhau thì tổng
  // giờ công bị đếm hai lần — và lương sẽ trả hai lần cho cùng một khoảng.
  segments.sort((a, b) => a.absStart - b.absStart);
  for (let i = 1; i < segments.length; i += 1) {
    const prev = segments[i - 1]!;
    const cur = segments[i]!;
    if (cur.absStart < prev.absEnd) {
      throw new ShiftError(
        'SEGMENTS_OVERLAP',
        `Ca "${def.code}": đoạn "${cur.name}" (${cur.startClock}) chồng lấn đoạn ` +
          `"${prev.name}" (kết thúc ${prev.endClock})`,
      );
    }
  }
  segments.forEach((s, i) => {
    s.index = i;
  });

  const last = segments[segments.length - 1]!;
  const totalNetMinutes = segments.reduce((acc, s) => acc + s.netMinutes, 0);
  const nightMinutes = segments.reduce((acc, s) => acc + s.nightMinutes, 0);

  const explicitStandard =
    def.standardHours !== null && def.standardHours !== undefined ? def.standardHours * 60 : null;
  if (explicitStandard !== null && explicitStandard <= 0) {
    throw new ShiftError('BAD_STANDARD_HOURS', `standardHours phải > 0, nhận ${def.standardHours}`);
  }
  const effectiveNet = explicitStandard ?? totalNetMinutes;
  if (standardDayHours <= 0) {
    throw new ShiftError('BAD_DAY_HOURS', `standardDayHours phải > 0, nhận ${standardDayHours}`);
  }

  return {
    code: def.code,
    name: def.name,
    type: def.type,
    workDate,
    segments,
    absStart: segments[0]!.absStart,
    absEnd: last.absEnd,
    totalNetMinutes,
    totalNetHours: totalNetMinutes / 60,
    standardDays: effectiveNet / 60 / standardDayHours,
    nightMinutes,
    nightHours: nightMinutes / 60,
    crossMidnight: segments.some((s) => s.endDayOffset > 0),
    startDate: workDate,
    endDate: last.endDayOffset > 0 ? addDays(workDate, last.endDayOffset) : workDate,
    nightStartMin,
    nightEndMin,
  };
}

/** Phút tuyệt đối → ngày lịch + phút trong ngày. */
export function absToCalendar(workDate: string, absMinute: number): { date: string; minutes: number } {
  const dayOffset = Math.floor(absMinute / MIN_PER_DAY);
  return {
    date: dayOffset === 0 ? workDate : addDays(workDate, dayOffset),
    minutes: absMinute - dayOffset * MIN_PER_DAY,
  };
}

// ---------------------------------------------------------------------------
// XOAY 3 CA 4 KÍP
// ---------------------------------------------------------------------------

export interface RotationDef {
  code: string;
  name: string;
  cycleLength: number;
  /** pattern[i] = mã ca của ngày thứ i trong chu kỳ; 'REST' = nghỉ */
  pattern: string[];
  /** Mã dùng cho ngày nghỉ trong pattern */
  restCode?: string;
  /** Số ngày lệch pha giữa hai kíp liên tiếp */
  phaseStep?: number;
}

/**
 * Tra mã ca của một kíp trong hệ xoay.
 *
 * @param teamIndex Chỉ số kíp, 0..(số kíp − 1). Kíp i lệch pha i × phaseStep ngày.
 * @returns Mã ca, hoặc null nếu ngày đó nghỉ.
 */
export function resolveRotationShiftCode(
  workDate: string,
  anchorDate: string,
  teamIndex: number,
  rotation: RotationDef,
): string | null {
  if (!Number.isInteger(teamIndex) || teamIndex < 0) {
    throw new ShiftError('BAD_TEAM_INDEX', `teamIndex phải là số nguyên không âm, nhận ${teamIndex}`);
  }
  const cycle = rotation.cycleLength;
  if (!Number.isInteger(cycle) || cycle <= 0) {
    throw new ShiftError('BAD_CYCLE', `cycleLength phải là số nguyên dương, nhận ${cycle}`);
  }
  if (rotation.pattern.length !== cycle) {
    // Số phần tử khác chu kỳ thì "ngày thứ i trong chu kỳ" là câu hỏi không có
    // đáp án — và nếu im lặng bỏ qua thì lịch xoay sẽ lệch dần mà không ai biết.
    throw new ShiftError(
      'PATTERN_LENGTH_MISMATCH',
      `pattern có ${rotation.pattern.length} phần tử nhưng cycleLength = ${cycle}`,
    );
  }

  const rawDays = diffDays(workDate, anchorDate);
  const phaseShift = (teamIndex * (rotation.phaseStep ?? 2)) % cycle;
  // `%` của JS giữ dấu của số bị chia, nên workDate trước anchorDate sẽ cho số âm.
  // Cộng cycle rồi lấy modulo lần nữa để luôn ra index hợp lệ.
  const idx = (((rawDays - phaseShift) % cycle) + cycle) % cycle;
  const code = rotation.pattern[idx];
  if (code === undefined) return null;
  return code === (rotation.restCode ?? 'REST') ? null : code;
}
