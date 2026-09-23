/**
 * ============================================================================
 * GHÉP CẶP QUẸT THẺ & TÍNH CÔNG NGÀY
 * ============================================================================
 *
 * Đầu vào là một ca ĐÃ RESOLVE (xem engine/shift.ts) và một đống quẹt thô từ máy
 * chấm công. Đầu ra là một ngày công: làm bao nhiêu phút, bao nhiêu phút đêm,
 * trễ bao nhiêu, OT loại nào.
 *
 * Ba quyết định thuật toán đáng nói:
 *
 *   1. FIRST-IN / LAST-OUT trong từng đoạn. Máy chấm công không đáng tin ở chỗ
 *      "đâu là vào, đâu là ra": người ta quẹt nhiều lần, quên quẹt, quẹt hộ.
 *      Lấy lần ĐẦU làm giờ vào và lần CUỐI làm giờ ra là quy ước ít sai nhất, và
 *      nó khớp với cách tính công của hầu hết doanh nghiệp VN.
 *
 *   2. KẸP vào khoảng kế hoạch. Đến sớm 1 tiếng không tự động thành 1 tiếng OT —
 *      phần ngoài kế hoạch được tách riêng để bộ phận nhân sự quyết định có tính
 *      OT hay không. Nếu cộng thẳng thì một người hay đến sớm sẽ có lương OT cao
 *      hơn người làm đúng giờ.
 *
 *   3. Thiếu quẹt thì SUY RA chứ không coi là vắng, nhưng ĐÁNH DẤU rõ. Quên quẹt
 *      là chuyện xảy ra hàng ngày; coi là vắng thì oan, mà im lặng bỏ qua thì mất
 *      khả năng kiểm soát. Nên giờ được suy từ kế hoạch, nguồn ghi INFERRED, và
 *      trạng thái thành MISSING_PUNCH để HR rà soát.
 *
 * Mọi con số ngưỡng (grace, cửa sổ, ngưỡng nửa ngày…) đều là THAM SỐ, vì mỗi
 * công ty một khác và cùng một công ty cũng đổi theo thoả ước lao động.
 */

import { nightOverlapMinutes, type ResolvedShift } from './shift.js';
import { overlapMinutes } from './time.js';

export class AttendanceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AttendanceError';
    this.code = code;
  }
}

export type CalendarDayKind = 'WORKING_DAY' | 'WEEKLY_REST' | 'PUBLIC_HOLIDAY' | 'PAID_LEAVE';

export interface PunchLike {
  /**
   * Thời điểm quẹt, dạng phút tuyệt đối SO VỚI 00:00 ngày workDate.
   * Quẹt 06:00 ngày hôm sau của ca đêm = 1800.
   */
  absMinute: number;
  /** Hướng do thiết bị khai báo. null/undefined = hệ thống tự suy luận. */
  direction?: 'IN' | 'OUT' | null;
  source?: string;
  /** true = bản ghi sinh ra từ đơn giải trình/công tác đã duyệt, không phải quẹt thật */
  isRegularization?: boolean;
}

export interface PairingConfig {
  /** Mở cửa sổ ghép cặp về trước giờ vào (phút) */
  windowBeforeMin: number;
  /** Mở cửa sổ ghép cặp về sau giờ ra (phút) */
  windowAfterMin: number;
  /** Đi trễ trong ngưỡng này không bị phạt */
  graceMinutes: number;
  /** Trễ thêm tới đây thì coi là nửa ngày công */
  halfDayAfterLateMin: number;
  /** Trễ quá đây thì coi là vắng cả ngày */
  absentAfterLateMin: number;
  /** Về sớm trong ngưỡng này không tính thiếu công */
  earlyLeaveToleranceMin: number;
  /** Số giờ công chuẩn/ngày để quy đổi công */
  standardDayHours: number;
  /**
   * Làm thiếu quá tỉ lệ này so với kế hoạch thì coi là nửa ngày.
   * Bản gốc hardcode 0.5; đưa ra tham số vì có nơi tính 0.6, có nơi 0.4.
   */
  halfDayWorkedRatio: number;
  /** OT vượt số giờ này trong ngày thì cảnh báo giới hạn 40h/tháng (Điều 107) */
  dailyOtWarningHours: number;
  /**
   * Chỉ cảnh báo khi OT trong ngày đạt mức này (phút).
   *
   * Bản gốc cảnh báo với MỌI OT > 0, và với dữ liệu thật thì 266/360 ngày có
   * cảnh báo — phần lớn là "phát sinh 0.15h làm thêm", tức 9 phút. Một danh sách
   * mà ba phần tư số dòng đều "cần xem" thì không ai xem, và dòng thật sự cần xem
   * sẽ chìm trong đó. OT vẫn được TÍNH và LƯU đầy đủ ở các cột riêng; cái bị bỏ
   * chỉ là dòng thông báo không đòi hỏi ai làm gì.
   */
  otWarningThresholdMin: number;
}

export const DEFAULT_PAIRING_CONFIG: PairingConfig = {
  windowBeforeMin: 180,
  windowAfterMin: 240,
  graceMinutes: 10,
  halfDayAfterLateMin: 120,
  absentAfterLateMin: 240,
  earlyLeaveToleranceMin: 0,
  standardDayHours: 8,
  halfDayWorkedRatio: 0.5,
  dailyOtWarningHours: 4,
  otWarningThresholdMin: 60,
};

export type PunchSource = 'PUNCH' | 'REGULARIZATION' | 'INFERRED' | null;

export interface PairedSegment {
  index: number;
  name: string;
  plannedIn: number;
  plannedOut: number;
  /** null = thiếu quẹt */
  actualIn: number | null;
  actualOut: number | null;
  /** Phút công thực, đã trừ nghỉ và đã kẹp vào khoảng kế hoạch */
  workedMinutes: number;
  nightMinutes: number;
  missingIn: boolean;
  missingOut: boolean;
  inSource: PunchSource;
  outSource: PunchSource;
}

export type AttendanceStatus =
  | 'PRESENT'
  | 'LATE'
  | 'ABSENT'
  | 'HALF_DAY'
  | 'MISSING_PUNCH'
  | 'WEEKLY_OFF'
  | 'HOLIDAY_OFF'
  | 'LEAVE_PAID';

export interface AttendanceResult {
  status: AttendanceStatus;
  segments: PairedSegment[];
  checkInAbs: number | null;
  checkOutAbs: number | null;
  workedMinutes: number;
  workedHours: number;
  standardDays: number;
  nightMinutes: number;
  nightHours: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  absentMinutes: number;
  /** OT theo loại ngày — ba hệ số 150/200/300% khác nhau */
  otWeekdayMinutes: number;
  otWeekendMinutes: number;
  otHolidayMinutes: number;
  /** Phần OT rơi vào khung đêm (được cộng thêm theo Điều 98 BLLĐ 2019) */
  otNightMinutes: number;
  regularizedMinutes: number;
  /** Cảnh báo để HR rà soát — không phải lỗi, nhưng không được im lặng */
  warnings: string[];
  /** Quẹt bị loại vì ngoài cửa sổ ghép cặp */
  rejectedPunches: number[];
}

/**
 * Các khoảng KHÔNG phải giờ làm của một ca, trong hệ phút tuyệt đối.
 *
 * Gồm hai loại: khe hở GIỮA các đoạn (ca gãy 08:00–12:00 + 14:00–18:00 có 120
 * phút ở giữa không ai trả) và khung giờ nghỉ trong từng đoạn.
 *
 * Cần cho nhánh ngày nghỉ/ngày lễ, nơi giờ làm được lấy theo khoảng bao từ quẹt
 * đầu đến quẹt cuối. Nếu không trừ hai loại khoảng này thì ca gãy đi làm ngày lễ
 * được tính 600 phút OT thay vì 480 — và ở hệ số 300% thì 120 phút đó là tiền
 * thật trả cho hai tiếng người ta không làm.
 */
function nonWorkedIntervals(
  shift: ResolvedShift,
): { lo: number; hi: number }[] {
  const out: { lo: number; hi: number }[] = [];
  const segs = [...shift.segments].sort((a, b) => a.absStart - b.absStart);
  for (let i = 0; i + 1 < segs.length; i++) {
    const gapLo = segs[i]!.absEnd;
    const gapHi = segs[i + 1]!.absStart;
    if (gapHi > gapLo) out.push({ lo: gapLo, hi: gapHi });
  }
  for (const sg of segs) {
    if (sg.breakAbsStart !== null && sg.breakAbsEnd !== null && sg.breakAbsEnd > sg.breakAbsStart) {
      out.push({ lo: sg.breakAbsStart, hi: sg.breakAbsEnd });
    }
  }
  return out;
}

/** Điểm giữa của một đoạn — ranh giới phân loại IN / OUT khi thiết bị không khai. */
function segmentMidpoint(plannedIn: number, plannedOut: number): number {
  return (plannedIn + plannedOut) / 2;
}

/**
 * Giờ nghỉ thực sự bị trừ cho khoảng đã làm [effIn, effOut).
 *
 * Có khung giờ nghỉ thì chỉ trừ PHẦN GIAO — người làm 08:00–11:00 không hề chạm
 * khung 12:00–13:00 nên không bị trừ phút nào. Không có khung thì buộc phải trừ
 * trọn, và đó là lý do định nghĩa ca NÊN khai khung nghỉ.
 */
function appliedBreak(
  seg: { breakMinutes: number; breakAbsStart: number | null; breakAbsEnd: number | null },
  effIn: number,
  effOut: number,
): number {
  if (seg.breakAbsStart === null || seg.breakAbsEnd === null) return seg.breakMinutes;
  return overlapMinutes(effIn, effOut, seg.breakAbsStart, seg.breakAbsEnd);
}

function sourceOf(p: PunchLike | undefined): PunchSource {
  if (!p) return null;
  return p.isRegularization ? 'REGULARIZATION' : 'PUNCH';
}

/**
 * Chặn NaN ngay cửa vào.
 *
 * `Math.max(0, undefined)` là NaN và NaN lan ra mọi phép tính phía sau mà không
 * ném lỗi — kết quả là một ngày công "0 phút" trông hoàn toàn bình thường. Thà
 * nổ ở đây.
 */
function assertFinite(n: number, what: string): void {
  if (!Number.isFinite(n)) {
    throw new AttendanceError('NOT_A_NUMBER', `${what} không phải số hữu hạn: ${String(n)}`);
  }
}

/**
 * Ghép cặp quẹt thẻ cho một ca đã resolve.
 *
 * @param shift   Ca kế hoạch đã resolve cho ngày công vụ
 * @param punches Quẹt trong ngày (absMinute so với 00:00 ngày workDate)
 * @param dayKind Loại ngày theo lịch
 * @param cfg     Ghi đè từng phần cấu hình
 */
export function pairPunches(
  shift: ResolvedShift,
  punches: readonly PunchLike[],
  dayKind: CalendarDayKind,
  cfg: Partial<PairingConfig> = {},
): AttendanceResult {
  const c: PairingConfig = { ...DEFAULT_PAIRING_CONFIG, ...cfg };

  // Kiểm tra cấu hình trước khi dùng: một ngưỡng âm sẽ đảo ngược logic phân loại
  // và cho ra kết quả sai mà không có gì báo.
  for (const [k, v] of Object.entries(c)) {
    assertFinite(v as number, `cấu hình ${k}`);
    if ((v as number) < 0) {
      throw new AttendanceError('BAD_CONFIG', `cấu hình ${k} không được âm: ${v}`);
    }
  }
  if (c.standardDayHours <= 0) {
    throw new AttendanceError('BAD_CONFIG', `standardDayHours phải > 0, nhận ${c.standardDayHours}`);
  }
  if (c.halfDayWorkedRatio <= 0 || c.halfDayWorkedRatio > 1) {
    throw new AttendanceError(
      'BAD_CONFIG',
      `halfDayWorkedRatio phải trong (0, 1], nhận ${c.halfDayWorkedRatio}`,
    );
  }
  for (const p of punches) assertFinite(p.absMinute, 'absMinute của quẹt');

  const warnings: string[] = [];
  const sorted = [...punches].sort((a, b) => a.absMinute - b.absMinute);

  // --- 1. Lọc theo cửa sổ ghép cặp -----------------------------------------
  // Quẹt lúc 03:00 không thuộc về ca 08:00–17:00; nếu cứ ghép thì giờ vào thành
  // 03:00 và người đó "đến sớm 5 tiếng" một cách vô lý.
  const winLo = shift.absStart - c.windowBeforeMin;
  const winHi = shift.absEnd + c.windowAfterMin;
  const inWin: PunchLike[] = [];
  const rejected: number[] = [];
  for (const p of sorted) {
    if (p.absMinute >= winLo && p.absMinute <= winHi) inWin.push(p);
    else rejected.push(p.absMinute);
  }

  // --- 2. Ngày nghỉ theo lịch: mọi giờ làm đều là OT -------------------------
  if (dayKind === 'WEEKLY_REST' || dayKind === 'PUBLIC_HOLIDAY') {
    return buildRestDayResult(shift, inWin, rejected, dayKind, warnings);
  }

  // --- 3. Gán quẹt vào từng đoạn (nearest-midpoint) --------------------------
  const buckets: PunchLike[][] = shift.segments.map(() => []);
  if (shift.segments.length === 1) {
    buckets[0]!.push(...inWin);
  } else {
    for (const p of inWin) {
      let bestIdx = 0;
      let bestDist = Number.POSITIVE_INFINITY;
      for (let i = 0; i < shift.segments.length; i += 1) {
        const seg = shift.segments[i]!;
        const dist = Math.abs(p.absMinute - segmentMidpoint(seg.absStart, seg.absEnd));
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      buckets[bestIdx]!.push(p);
    }
  }

  // --- 4. FIRST-IN / LAST-OUT trong từng đoạn --------------------------------
  const paired: PairedSegment[] = shift.segments.map((seg, i) => {
    const bucket = buckets[i]!;
    const ins: PunchLike[] = [];
    const outs: PunchLike[] = [];
    const mid = segmentMidpoint(seg.absStart, seg.absEnd);

    // Phân loại IN / OUT.
    //
    // BUG ĐÃ SỬA: bản trước suy hướng HOÀN TOÀN theo điểm giữa đoạn, và điều đó
    // phá đúng trường hợp phổ biến nhất. Người làm 08:00–11:00 rồi về có hai
    // quẹt 480 và 660; điểm giữa đoạn là 750 nên CẢ HAI đều bị coi là quẹt VÀO,
    // giờ ra được suy thành 17:00, và 3 giờ làm được tính thành 8 giờ công.
    //
    // Quy tắc đúng: khi có TỪ HAI quẹt trở lên thì lần đầu là VÀO và lần cuối là
    // RA — đó chính là FIRST-IN/LAST-OUT, không cần đoán. Điểm giữa chỉ dùng khi
    // có ĐÚNG MỘT quẹt (không có cách nào khác) và khi thiết bị không khai hướng.
    const declared = bucket.filter((p) => p.direction === 'IN' || p.direction === 'OUT');
    const undeclared = bucket.filter((p) => p.direction !== 'IN' && p.direction !== 'OUT');

    for (const p of declared) {
      if (p.direction === 'IN') ins.push(p);
      else outs.push(p);
    }

    if (undeclared.length >= 2) {
      const sortedUnd = [...undeclared].sort((a, b) => a.absMinute - b.absMinute);
      ins.push(sortedUnd[0]!);
      outs.push(sortedUnd[sortedUnd.length - 1]!);
    } else if (undeclared.length === 1) {
      const p = undeclared[0]!;
      if (p.absMinute < mid) ins.push(p);
      else outs.push(p);
    }

    ins.sort((a, b) => a.absMinute - b.absMinute);
    outs.sort((a, b) => b.absMinute - a.absMinute); // giảm dần để lấy LAST-OUT

    const firstIn = ins[0] ?? null;
    const lastOut = outs[0] ?? null;

    let actualIn = firstIn?.absMinute ?? null;
    let actualOut = lastOut?.absMinute ?? null;
    let inSrc = sourceOf(firstIn ?? undefined);
    let outSrc = sourceOf(lastOut ?? undefined);

    if (actualIn === null && actualOut !== null) {
      actualIn = seg.absStart;
      inSrc = 'INFERRED';
      warnings.push(
        `Đoạn "${seg.name}": thiếu quẹt VÀO — tạm lấy giờ kế hoạch ${seg.startClock}`,
      );
    }
    if (actualOut === null && actualIn !== null) {
      actualOut = seg.absEnd;
      outSrc = 'INFERRED';
      warnings.push(`Đoạn "${seg.name}": thiếu quẹt RA — tạm lấy giờ kế hoạch ${seg.endClock}`);
    }

    let workedMinutes = 0;
    if (actualIn !== null && actualOut !== null && actualOut > actualIn) {
      // KẸP vào khoảng kế hoạch: phần đến sớm / ở lại muộn không tự thành giờ
      // công chính, nó được tách ra tính OT ở bước 7.
      const effIn = Math.max(actualIn, seg.absStart);
      const effOut = Math.min(actualOut, seg.absEnd);
      workedMinutes = Math.max(0, effOut - effIn - appliedBreak(seg, effIn, effOut));
    }

    const nightMinutes =
      actualIn !== null && actualOut !== null
        ? nightOverlapMinutes(
            Math.max(actualIn, seg.absStart),
            Math.min(actualOut, seg.absEnd),
            shift.nightStartMin,
            shift.nightEndMin,
          )
        : 0;

    return {
      index: i,
      name: seg.name,
      plannedIn: seg.absStart,
      plannedOut: seg.absEnd,
      actualIn,
      actualOut,
      workedMinutes,
      nightMinutes,
      missingIn: firstIn === null,
      missingOut: lastOut === null,
      inSource: inSrc,
      outSource: outSrc,
    };
  });

  // --- 5. Suy chéo đoạn: quên quẹt giữa ca gãy -------------------------------
  // Đoạn i thiếu OUT nhưng đoạn i+1 có IN => lấy IN của đoạn sau làm OUT. Người
  // làm ca gãy rất hay quên quẹt lúc đổi đoạn vì họ không rời khỏi xưởng.
  for (let i = 0; i < paired.length - 1; i += 1) {
    const cur = paired[i]!;
    const next = paired[i + 1]!;
    if (
      cur.missingOut &&
      cur.actualIn !== null &&
      next.actualIn !== null &&
      next.actualIn > cur.plannedIn
    ) {
      cur.actualOut = Math.min(next.actualIn, cur.plannedOut);
      cur.outSource = 'INFERRED';
      cur.missingOut = false;
      const effIn = Math.max(cur.actualIn, cur.plannedIn);
      const segI = shift.segments[i]!;
      cur.workedMinutes = Math.max(
        0,
        cur.actualOut - effIn - appliedBreak(segI, effIn, cur.actualOut),
      );
      warnings.push(`Đoạn "${cur.name}": suy giờ RA từ quẹt vào của đoạn "${next.name}"`);
    }
  }

  // --- 6. Tổng hợp ------------------------------------------------------------
  const firstSeg = paired[0]!;
  const lastSeg = paired[paired.length - 1]!;
  const checkInAbs = firstSeg.actualIn;
  const checkOutAbs = lastSeg.actualOut;

  const workedMinutes = paired.reduce((acc, s) => acc + s.workedMinutes, 0);
  const nightMinutes = paired.reduce((acc, s) => acc + s.nightMinutes, 0);
  const regularizedMinutes = paired.reduce(
    (acc, s) => acc + (s.inSource === 'REGULARIZATION' || s.outSource === 'REGULARIZATION' ? s.workedMinutes : 0),
    0,
  );

  const rawLate = checkInAbs !== null ? checkInAbs - shift.absStart : 0;
  const lateMinutes = rawLate > c.graceMinutes ? Math.round(rawLate) : 0;
  if (rawLate > 0 && rawLate <= c.graceMinutes) {
    warnings.push(
      `Đi trễ ${Math.round(rawLate)}' — trong grace period ${c.graceMinutes}', không phạt`,
    );
  }

  const rawEarly = checkOutAbs !== null ? shift.absEnd - checkOutAbs : 0;
  const earlyLeaveMinutes = rawEarly > c.earlyLeaveToleranceMin ? Math.round(Math.max(0, rawEarly)) : 0;

  // --- 7. Làm thêm giờ ---------------------------------------------------------
  const ot = computeOvertime(shift, paired, checkOutAbs, dayKind, c, warnings);

  // --- 8. Trạng thái -----------------------------------------------------------
  const status = resolveStatus({
    paired,
    checkInAbs,
    checkOutAbs,
    workedMinutes,
    plannedMinutes: shift.totalNetMinutes,
    lateMinutes,
    cfg: c,
  });

  // Ngày nghỉ/ngày lễ không có "vắng" — không đi làm là đúng.
  const absentMinutes =
    status === 'ABSENT' || status === 'WEEKLY_OFF' || status === 'HOLIDAY_OFF'
      ? 0
      : Math.max(0, shift.totalNetMinutes - workedMinutes);

  return {
    status,
    segments: paired,
    checkInAbs,
    checkOutAbs,
    workedMinutes,
    workedHours: workedMinutes / 60,
    standardDays: workedMinutes / 60 / c.standardDayHours,
    nightMinutes,
    nightHours: nightMinutes / 60,
    lateMinutes,
    earlyLeaveMinutes,
    absentMinutes,
    otWeekdayMinutes: ot.weekday,
    otWeekendMinutes: ot.weekend,
    otHolidayMinutes: ot.holiday,
    otNightMinutes: ot.night,
    regularizedMinutes,
    warnings,
    rejectedPunches: rejected,
  };
}

// ---------------------------------------------------------------------------
// LÀM THÊM GIỜ (Điều 98 BLLĐ 2019)
// ---------------------------------------------------------------------------

interface OtResult {
  weekday: number;
  weekend: number;
  holiday: number;
  night: number;
}

/**
 * OT = phần thời gian LÀM THỰC TẾ nằm ngoài khoảng kế hoạch của ca.
 *
 * Tách riêng phần rơi vào khung đêm: Điều 98 yêu cầu cộng thêm cho OT ban đêm,
 * nên nếu gộp chung thì không còn cách nào tính đúng hệ số.
 */
function computeOvertime(
  shift: ResolvedShift,
  paired: PairedSegment[],
  checkOutAbs: number | null,
  dayKind: CalendarDayKind,
  cfg: PairingConfig,
  warnings: string[],
): OtResult {
  const res: OtResult = { weekday: 0, weekend: 0, holiday: 0, night: 0 };

  const intervals: Array<[number, number]> = [];
  for (const s of paired) {
    if (s.actualIn === null || s.actualOut === null || s.actualOut <= s.actualIn) continue;
    // Đến sớm rồi làm luôn
    if (s.actualIn < s.plannedIn) {
      const end = Math.min(s.actualOut, s.plannedIn);
      if (end > s.actualIn) intervals.push([s.actualIn, end]);
    }
    // Ở lại làm thêm sau giờ ra
    if (s.actualOut > s.plannedOut) {
      const start = Math.max(s.actualIn, s.plannedOut);
      if (s.actualOut > start) intervals.push([start, s.actualOut]);
    }
  }

  // Gộp khoảng chồng lấn — hai đoạn OT gối nhau mà cộng riêng thì sẽ đếm trùng
  // phần giao, và lương OT bị trả hai lần cho cùng một khoảng thời gian.
  intervals.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const iv of intervals) {
    const last = merged[merged.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else merged.push([iv[0], iv[1]]);
  }

  let totalOt = 0;
  for (const [a, b] of merged) {
    const len = b - a;
    totalOt += len;
    res.night += nightOverlapMinutes(a, b, shift.nightStartMin, shift.nightEndMin);
    if (dayKind === 'PUBLIC_HOLIDAY') res.holiday += len;
    else if (dayKind === 'WEEKLY_REST') res.weekend += len;
    else res.weekday += len;
  }

  if (totalOt >= cfg.otWarningThresholdMin) {
    const label = dayKind === 'PUBLIC_HOLIDAY' ? '300%' : dayKind === 'WEEKLY_REST' ? '200%' : '150%';
    warnings.push(`Phát sinh ${(totalOt / 60).toFixed(2)}h làm thêm (hệ số ${label})`);
  }
  if (
    checkOutAbs !== null &&
    checkOutAbs > shift.absEnd &&
    dayKind === 'WORKING_DAY' &&
    (checkOutAbs - shift.absEnd) / 60 >= cfg.dailyOtWarningHours
  ) {
    warnings.push(
      `OT ${((checkOutAbs - shift.absEnd) / 60).toFixed(2)}h ≥ ${cfg.dailyOtWarningHours}h — ` +
        'kiểm tra giới hạn 40h/tháng (Điều 107 BLLĐ 2019)',
    );
  }
  return res;
}

// ---------------------------------------------------------------------------
// NGÀY NGHỈ THEO LỊCH: mọi giờ làm đều là OT
// ---------------------------------------------------------------------------

function buildRestDayResult(
  shift: ResolvedShift,
  inWin: readonly PunchLike[],
  rejected: number[],
  dayKind: CalendarDayKind,
  warnings: string[],
): AttendanceResult {
  const base: AttendanceResult = {
    status: dayKind === 'WEEKLY_REST' ? 'WEEKLY_OFF' : 'HOLIDAY_OFF',
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
    warnings,
    rejectedPunches: rejected,
  };

  if (inWin.length === 0) return base;

  // Ngày nghỉ không có ca kế hoạch để bám, nên ghép FIRST-IN / LAST-OUT tự do
  // trên toàn bộ quẹt trong cửa sổ.
  const ins = [...inWin].sort((a, b) => a.absMinute - b.absMinute);
  const firstIn = ins[0]!;
  const lastOut = ins[ins.length - 1]!;
  const spanLo = firstIn.absMinute;
  const spanHi = lastOut.absMinute;
  // Trừ khe giữa các đoạn và khung giờ nghỉ. Ca tổng hợp (ngày không xếp ca) chỉ
  // có một đoạn và không có giờ nghỉ nên không bị trừ gì — đúng như mong đợi.
  let worked = Math.max(0, spanHi - spanLo);
  for (const iv of nonWorkedIntervals(shift)) {
    worked -= overlapMinutes(spanLo, spanHi, iv.lo, iv.hi);
  }
  worked = Math.max(0, worked);
  const night = nightOverlapMinutes(
    spanLo,
    spanHi,
    shift.nightStartMin,
    shift.nightEndMin,
  );

  warnings.push(
    `Ngày ${dayKind === 'WEEKLY_REST' ? 'nghỉ hằng tuần' : 'lễ, tết'} có phát sinh công — toàn bộ tính OT`,
  );
  return {
    ...base,
    status: 'PRESENT',
    checkInAbs: firstIn.absMinute,
    checkOutAbs: lastOut.absMinute,
    workedMinutes: worked,
    workedHours: worked / 60,
    // standardDays = 0: ngày nghỉ không có công chính, nếu tính thì sẽ trả hai lần.
    standardDays: 0,
    otWeekendMinutes: dayKind === 'WEEKLY_REST' ? worked : 0,
    otHolidayMinutes: dayKind === 'PUBLIC_HOLIDAY' ? worked : 0,
    otNightMinutes: night,
    regularizedMinutes: firstIn.isRegularization || lastOut.isRegularization ? worked : 0,
  };
}

// ---------------------------------------------------------------------------
// TRẠNG THÁI
// ---------------------------------------------------------------------------

function resolveStatus(args: {
  paired: PairedSegment[];
  checkInAbs: number | null;
  checkOutAbs: number | null;
  workedMinutes: number;
  plannedMinutes: number;
  lateMinutes: number;
  cfg: PairingConfig;
}): AttendanceStatus {
  const { paired, checkInAbs, checkOutAbs, workedMinutes, plannedMinutes, lateMinutes, cfg } = args;

  if (checkInAbs === null && checkOutAbs === null) return 'ABSENT';
  if (checkInAbs === null || checkOutAbs === null) return 'MISSING_PUNCH';

  // Có giờ bị SUY RA nghĩa là thiếu quẹt — vẫn tính công nhưng phải để HR thấy.
  if (paired.some((s) => s.inSource === 'INFERRED' || s.outSource === 'INFERRED')) {
    return 'MISSING_PUNCH';
  }

  if (lateMinutes >= cfg.absentAfterLateMin) return 'ABSENT';
  if (lateMinutes >= cfg.halfDayAfterLateMin) return 'HALF_DAY';
  if (plannedMinutes > 0 && workedMinutes < plannedMinutes * cfg.halfDayWorkedRatio) {
    return 'HALF_DAY';
  }
  if (lateMinutes > 0) return 'LATE';
  return 'PRESENT';
}

// ---------------------------------------------------------------------------
// ĐỔI QUA LẠI GIỮA THỜI ĐIỂM THẬT VÀ PHÚT TUYỆT ĐỐI
// ---------------------------------------------------------------------------

/**
 * Đổi một thời điểm quẹt thành phút tuyệt đối so với 00:00 ngày công vụ.
 *
 * workDate = 2026-03-05, quẹt lúc 2026-03-06 06:00 → 1800.
 */
export function punchToAbsMinute(
  punchLocal: { date: string; minutes: number },
  workDate: string,
): number {
  const dayDiff = diffDaysSafe(punchLocal.date, workDate);
  return dayDiff * 1440 + punchLocal.minutes;
}

function diffDaysSafe(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) {
    throw new AttendanceError('BAD_DATE', `Ngày không hợp lệ: ${a} / ${b}`);
  }
  return Math.round((da - db) / 86_400_000);
}
