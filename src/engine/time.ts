/**
 * ============================================================================
 * TIỆN ÍCH THỜI GIAN CHO CHẤM CÔNG
 * ============================================================================
 *
 * Mọi tính toán ca kíp dùng "phút trong ngày" cộng "số ngày lệch", chứ không dùng
 * Date trực tiếp. Lý do: ca đêm vắt qua 0h mà so bằng Date thì rất dễ nhầm ngày,
 * và mọi phép cộng trừ phải tự lo DST.
 *
 * QUY ƯỚC: DB lưu UTC, còn ca kíp tính trên GIỜ ĐỊA PHƯƠNG của trụ sở
 * (mặc định Asia/Ho_Chi_Minh = UTC+7, không có DST). Múi giờ không DST là điều
 * kiện để cách làm "dịch epoch rồi dùng hàm UTC" đúng; nếu trụ sở ở vùng có DST
 * thì phải đổi sang Intl.DateTimeFormat.
 */

export const MIN_PER_DAY = 24 * 60;
export const VN_OFFSET_MS = 7 * 60 * 60 * 1000;

/**
 * "08:30" → 510. Chấp nhận "24:00" → 1440 (cuối ngày, dùng cho ca kết thúc nửa đêm).
 *
 * NÉM LỖI với định dạng sai thay vì trả 0: một giờ vào bị hiểu nhầm thành 00:00
 * sẽ sinh ra ca dài 24 tiếng và toàn bộ giờ công phía sau đều sai, trong khi không
 * có gì báo.
 */
export function parseTimeOfDay(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(hhmm.trim());
  if (!m) throw new RangeError(`Định dạng giờ không hợp lệ: "${hhmm}" (cần HH:mm)`);
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 24 || mi > 59) throw new RangeError(`Giờ ngoài phạm vi: "${hhmm}"`);
  if (h === 24 && mi !== 0) throw new RangeError(`Giờ ngoài phạm vi: "${hhmm}"`);
  return h * 60 + mi;
}

/** 510 → "08:30" */
export function formatTimeOfDay(minutes: number): string {
  const m = ((Math.round(minutes) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export interface LocalMoment {
  /** YYYY-MM-DD tại múi giờ địa phương */
  date: string;
  /** phút trong ngày tại múi giờ địa phương */
  minutes: number;
  /** epoch ms đã dịch, để các phép tính Date trở thành số học địa phương */
  localTs: number;
}

/**
 * Chuyển một thời điểm sang biểu diễn địa phương tại múi giờ cố định không DST.
 *
 * Kỹ thuật: cộng offset vào epoch rồi đọc bằng các hàm getUTC*. Đúng VÌ offset
 * không đổi; nó KHÔNG đúng ở vùng có DST.
 */
export function toLocalMoment(d: Date | string | number, offsetMs = VN_OFFSET_MS): LocalMoment {
  const ts = new Date(d).getTime();
  if (Number.isNaN(ts)) throw new RangeError(`Thời điểm không hợp lệ: ${String(d)}`);
  const localTs = ts + offsetMs;
  const ld = new Date(localTs);
  return {
    date: ld.toISOString().slice(0, 10),
    // Giây chia 60 để ra PHẦN của một phút. Bản gốc chia 60000 — chia vậy thì
    // giây gần như luôn bằng 0, và mọi phép tính có giây đều lệch tới 59 giây
    // mà không ai thấy vì số vẫn "trông đúng".
    minutes: ld.getUTCHours() * 60 + ld.getUTCMinutes() + ld.getUTCSeconds() / 60,
    localTs,
  };
}

/** Chuỗi local 'YYYY-MM-DD' + phút trong ngày → Date UTC. */
export function fromLocal(dateStr: string, minutes: number, offsetMs = VN_OFFSET_MS): Date {
  const base = new Date(`${dateStr}T00:00:00.000Z`).getTime();
  if (Number.isNaN(base)) throw new RangeError(`Ngày không hợp lệ: ${dateStr}`);
  return new Date(base + Math.round(minutes) * 60_000 - offsetMs);
}

export function addDays(dateStr: string, days: number): string {
  const base = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(base.getTime())) throw new RangeError(`Ngày không hợp lệ: ${dateStr}`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Số ngày giữa hai ngày lịch (a − b). */
export function diffDays(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00.000Z`).getTime();
  const db = new Date(`${b}T00:00:00.000Z`).getTime();
  if (Number.isNaN(da) || Number.isNaN(db)) {
    throw new RangeError(`Ngày không hợp lệ: ${a} / ${b}`);
  }
  return Math.round((da - db) / 86_400_000);
}

/** Giao của hai khoảng; null nếu không giao. */
export function overlap(a1: number, a2: number, b1: number, b2: number): [number, number] | null {
  const lo = Math.max(a1, b1);
  const hi = Math.min(a2, b2);
  return hi > lo ? [lo, hi] : null;
}

export function overlapMinutes(a1: number, a2: number, b1: number, b2: number): number {
  const r = overlap(a1, a2, b1, b2);
  return r ? r[1] - r[0] : 0;
}

/** 0 = Chủ nhật … 6 = Thứ bảy, tính trên ngày local. */
export function dayOfWeek(dateStr: string): number {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new RangeError(`Ngày không hợp lệ: ${dateStr}`);
  return d.getUTCDay();
}

export function isWeekend(dateStr: string): boolean {
  const dow = dayOfWeek(dateStr);
  return dow === 0 || dow === 6;
}

/** Làm tròn XUỐNG bội số của step (vd step=5 thì 08:07 → 08:05). */
export function floorMinutes(minutes: number, step: number): number {
  if (step <= 0) return minutes;
  return Math.floor(minutes / step) * step;
}

/** Số phút giữa hai LocalMoment (có dấu: a − b). */
export function minutesBetween(a: LocalMoment, b: LocalMoment): number {
  return (a.localTs - b.localTs) / 60_000;
}
