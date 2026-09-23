/**
 * ============================================================================
 * SERVICE — NHẬN QUẸT THẺ TỪ THIẾT BỊ (ADMS + Hikvision ISAPI)
 * ============================================================================
 *
 * Hai giao thức khác nhau ở tầng parse nhưng GIỐNG NHAU ở bốn việc còn lại: xác
 * thực thiết bị, ánh xạ số thẻ → mã nhân sự, khử trùng lặp, và từ chối một cách
 * có kiểm soát. Nên bốn việc đó nằm ở đây, và mỗi route chỉ còn là "parse theo
 * giao thức của nó rồi gọi hàm này".
 *
 * BA QUYẾT ĐỊNH ĐÁNG CHÚ Ý:
 *
 * 1. Thiết bị không xác thực bằng JWT — nó không giữ được token. Nhưng endpoint
 *    mở toang thì bất kỳ ai biết URL cũng bơm được quẹt giả cho cả công ty. Nên
 *    mỗi máy một khoá chia sẻ, so bằng phép so thời gian không đổi.
 *
 * 2. Khử trùng lặp dựa vào RÀNG BUỘC DUY NHẤT ở DB, không dựa vào "đọc xem có
 *    chưa rồi mới ghi". Máy ADMS gửi lại log nhiều lần khi mất mạng, và hai lần
 *    gửi có thể đến gần như đồng thời — cách đọc-rồi-ghi có cửa race.
 *
 * 3. Số thẻ KHÔNG tìm thấy nhân viên thì báo về, KHÔNG bỏ qua im lặng và KHÔNG
 *    tự tạo nhân viên. Một máy vừa được nạp lại vân tay với dãy PIN mới sẽ sinh
 *    ra hàng trăm quẹt "không biết của ai", và đó là thông tin người vận hành
 *    phải thấy ngay, không phải ba tuần sau khi bảng lương thiếu người.
 */

import { timingSafeEqual } from 'node:crypto';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { employees, rawPunches, shiftDevices } from '@/db/schema';
import { mapWorkCodeToSource } from '@/engine/adms';

export class DeviceIngestError extends Error {
  constructor(
    readonly code: 'UNKNOWN_DEVICE' | 'BAD_KEY' | 'DEVICE_INACTIVE' | 'NO_DEVICE_ID',
    message: string,
  ) {
    super(message);
    this.name = 'DeviceIngestError';
  }
}

/**
 * So sánh hai chuỗi khoá trong thời gian KHÔNG phụ thuộc nội dung.
 *
 * `a === b` dừng ở byte khác biệt đầu tiên, nên thời gian trả lời tiết lộ độ dài
 * phần đúng — đo đủ nhiều lần thì dò được khoá. Nghe lý thuyết với một máy chấm
 * công trong mạng LAN, nhưng endpoint này bắt buộc phải phơi ra mạng để máy gọi
 * được, nên nó không còn là mạng nội bộ nữa.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export interface DeviceRecord {
  /** Số thẻ / PIN trên máy */
  deviceUserId: string;
  punchedAt: Date;
  /**
   * Phương thức xác thực. ADMS cho `workCode` (số) nên route tự map; Hikvision
   * không nói rõ nên để null.
   */
  verifyMethod?: 'FACE' | 'FINGERPRINT' | 'CARD' | 'PASSWORD' | 'UNKNOWN' | null;
  /** Chuỗi gốc — giữ để đối soát khi có tranh chấp */
  rawLine?: string;
}

export interface IngestResult {
  received: number;
  inserted: number;
  /** Gửi lại — không phải lỗi. Máy ADMS làm việc này mỗi lần mất mạng. */
  duplicates: number;
  /** Số thẻ không khớp nhân viên nào. */
  unmatched: { deviceUserId: string; count: number }[];
  /** Mã lý do thiết bị báo về (Hikvision): quẹt bị từ chối ở phía máy. */
  rejectedByDevice: number;
}

/**
 * Xác thực thiết bị và trả về bản ghi của nó.
 *
 * Ném `DeviceIngestError` với MÃ riêng cho từng trường hợp, vì ba trường hợp này
 * cần ba cách xử lý khác nhau ở phía vận hành: máy chưa đăng ký (thêm vào danh
 * mục), khoá sai (cấu hình lại trên máy), máy đã ngừng hoạt động (thay máy).
 */
export async function authenticateDevice(
  db: Db,
  serial: string,
  key: string | null,
): Promise<{ serial: string; siteCode: string | null; deviceType: string }> {
  if (!serial) throw new DeviceIngestError('NO_DEVICE_ID', 'Thiếu số serial của thiết bị');

  const [dev] = await db
    .select({
      serial: shiftDevices.serial,
      webhookKey: shiftDevices.webhookKey,
      active: shiftDevices.active,
      siteCode: shiftDevices.siteCode,
      deviceType: shiftDevices.deviceType,
    })
    .from(shiftDevices)
    .where(eq(shiftDevices.serial, serial))
    .limit(1);

  if (!dev) throw new DeviceIngestError('UNKNOWN_DEVICE', `Thiết bị chưa đăng ký: ${serial}`);
  if (!dev.active) throw new DeviceIngestError('DEVICE_INACTIVE', `Thiết bị đã ngừng dùng: ${serial}`);
  if (!dev.webhookKey || !key || !safeEqual(dev.webhookKey, key)) {
    // Cùng một thông báo cho "máy chưa được cấp khoá" và "khoá sai": nói rõ hơn
    // là giúp người dò khoá biết mình đang tiến gần.
    throw new DeviceIngestError('BAD_KEY', 'Khoá thiết bị không hợp lệ');
  }
  return { serial: dev.serial, siteCode: dev.siteCode, deviceType: dev.deviceType };
}

/**
 * Ghi quẹt thô. Idempotent: gửi lại cùng một quẹt thì `duplicates` tăng,
 * `inserted` không đổi.
 */
export async function ingestPunches(
  db: Db,
  deviceSerial: string,
  records: DeviceRecord[],
  opts: { source: 'ADMS' | 'DEVICE'; rejectedByDevice?: number } = { source: 'DEVICE' },
): Promise<IngestResult> {
  const result: IngestResult = {
    received: records.length,
    inserted: 0,
    duplicates: 0,
    unmatched: [],
    rejectedByDevice: opts.rejectedByDevice ?? 0,
  };
  if (records.length === 0) return result;

  // --- Ánh xạ số thẻ → mã nhân sự, MỘT truy vấn cho cả batch ----------------
  const ids = [...new Set(records.map((r) => r.deviceUserId).filter((x) => x !== ''))];
  const people = ids.length
    ? await db
        .select({ deviceUserId: employees.deviceUserId, employeeCode: employees.employeeCode })
        .from(employees)
        .where(inArray(employees.deviceUserId, ids))
    : [];
  const byDeviceId = new Map(people.map((p) => [p.deviceUserId, p.employeeCode]));

  const unmatchedCount = new Map<string, number>();

  for (const r of records) {
    const employeeCode = byDeviceId.get(r.deviceUserId);
    if (!employeeCode) {
      unmatchedCount.set(r.deviceUserId, (unmatchedCount.get(r.deviceUserId) ?? 0) + 1);
      continue;
    }

    const inserted = await db
      .insert(rawPunches)
      .values({
        employeeCode,
        deviceSerial,
        punchedAt: r.punchedAt,
        direction: null, // FIRST-IN/LAST-OUT do engine chấm công quyết định
        source: opts.source,
        verifyMethod: r.verifyMethod ?? null,
      })
      .onConflictDoNothing({
        target: [rawPunches.employeeCode, rawPunches.deviceSerial, rawPunches.punchedAt],
      })
      .returning({ id: rawPunches.id });

    if (inserted.length > 0) result.inserted += 1;
    else result.duplicates += 1;
  }

  result.unmatched = [...unmatchedCount.entries()]
    .map(([deviceUserId, count]) => ({ deviceUserId, count }))
    .sort((a, b) => b.count - a.count || a.deviceUserId.localeCompare(b.deviceUserId));

  return result;
}

/**
 * Số thẻ đã có trong danh mục nhưng chưa gán `device_user_id` — để trang quản trị
 * gợi ý thay vì để người vận hành tự đoán tại sao quẹt không vào.
 */
export async function employeesWithoutDeviceId(db: Db): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(employees)
    .where(and(eq(employees.active, true), isNull(employees.deviceUserId)));
  return r?.n ?? 0;
}

/** mapWorkCodeToSource được export lại để route không phải import từ engine. */
export { mapWorkCodeToSource };
