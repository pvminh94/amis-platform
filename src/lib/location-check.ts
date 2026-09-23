/**
 * ============================================================================
 * SERVICE — KIỂM TRA VỊ TRÍ QUẸT THẺ THEO GEOFENCE
 * ============================================================================
 *
 * Chạy TRƯỚC khi tính công. Kết quả được GHI NGƯỢC vào `raw_punches`, không giữ
 * trong bộ nhớ:
 *
 *   Hàng rào là tham số CÓ KHOẢNG HIỆU LỰC. Nếu tính lại mỗi lần xem thì ba
 *   tháng sau, một quẹt thẻ cũ sẽ bị đánh giá theo hàng rào MỚI — và kết luận
 *   hôm nay sẽ khác kết luận đã dùng để quyết định ngày hôm đó. Ghi lại tại thời
 *   điểm kiểm tra là cách duy nhất giữ được tính nhất quán đó. Cùng nguyên tắc
 *   với `policySnapshot` của phiếu lương.
 *
 * CHỈ kiểm tra thiết bị MOBILE. Máy chấm công cố định được bắt vít vào tường,
 * vị trí của nó là hiển nhiên, và nó không gửi toạ độ — áp geofence cho nó thì
 * mọi quẹt thẻ đều thành "không có GPS", tức là biến một hệ thống đang chạy đúng
 * thành một danh sách dài cảnh báo vô nghĩa.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { Db } from '@/db/client';
import { rawPunches, shiftDevices } from '@/db/schema';
import { validateGpsPunch } from '@/engine/geofence';
import { configFromParams, fenceFromParams, gpsFixFromPunch } from '@/lib/location';
import { resolvePolicy, PolicyError } from '@/policy/registry';
import { geofenceParamsSchema, type GeofenceParams } from '@/policy/geofence-params';

export type GeoStatus = 'TRUSTED' | 'REVIEW' | 'REJECTED' | 'NO_FENCE' | 'NO_GPS';

export interface LocationCheckSummary {
  /** Số quẹt đã kiểm tra (chỉ tính quẹt từ thiết bị MOBILE). */
  checked: number;
  byStatus: Record<GeoStatus, number>;
  /** Địa điểm có quẹt nhưng CHƯA cấu hình hàng rào. */
  sitesWithoutFence: string[];
  /** Nhân viên có quẹt bị từ chối, kèm số quẹt. */
  rejectedByEmployee: { employeeCode: string; count: number }[];
  errors: string[];
}

const EMPTY: Record<GeoStatus, number> = {
  TRUSTED: 0,
  REVIEW: 0,
  REJECTED: 0,
  NO_FENCE: 0,
  NO_GPS: 0,
};

/**
 * Hàng rào resolve theo (mã địa điểm, ngày).
 *
 * Cache trong một Map vì một ca làm có hàng chục quẹt nhưng chỉ một hàng rào.
 * Resolve trong vòng lặp không chỉ chậm — nó còn có thể resolve ra HAI PHIÊN BẢN
 * khác nhau cho hai quẹt cùng ngày nếu ai đó kích hoạt chính sách mới giữa chừng.
 */
async function fenceFor(
  db: Db,
  siteCode: string | null,
  at: string,
  cache: Map<string, GeofenceParams | null>,
): Promise<GeofenceParams | null> {
  if (!siteCode) return null;
  const key = `${siteCode}|${at}`;
  if (cache.has(key)) return cache.get(key)!;

  let params: GeofenceParams | null = null;
  try {
    const p = await resolvePolicy<GeofenceParams>('GEOFENCE', at, geofenceParamsSchema, db, siteCode);
    params = p.params;
  } catch (e) {
    // NOT_RESOLVABLE ở đây KHÔNG phải lỗi cần ném. Địa điểm chưa có hàng rào là
    // một trạng thái cấu hình hợp lệ (văn phòng mới mở, chưa kịp vẽ vùng) — và
    // nếu ném thì một địa điểm thiếu cấu hình sẽ làm hỏng cả lần tính công của
    // những địa điểm khác. Ghi nhận thành NO_FENCE và nêu trong báo cáo.
    if (!(e instanceof PolicyError) || e.code !== 'NOT_RESOLVABLE') throw e;
    params = null;
  }
  cache.set(key, params);
  return params;
}

export interface LocationCheckOptions {
  /** Từ ngày (YYYY-MM-DD, theo giờ VN). */
  from: string;
  to: string;
  employeeCodes?: string[];
  /** Ghi ngược kết quả vào DB. false = chỉ tính, dùng cho xem trước. */
  persist?: boolean;
}

export async function validatePunchLocations(
  db: Db,
  opts: LocationCheckOptions,
): Promise<LocationCheckSummary> {
  const summary: LocationCheckSummary = {
    checked: 0,
    byStatus: { ...EMPTY },
    sitesWithoutFence: [],
    rejectedByEmployee: [],
    errors: [],
  };

  // Chỉ lấy quẹt từ thiết bị MOBILE — xem giải thích ở đầu file.
  const rows = await db
    .select({
      id: rawPunches.id,
      employeeCode: rawPunches.employeeCode,
      punchedAt: rawPunches.punchedAt,
      deviceSerial: rawPunches.deviceSerial,
      latitude: rawPunches.latitude,
      longitude: rawPunches.longitude,
      accuracyMeters: rawPunches.accuracyMeters,
      bssid: rawPunches.bssid,
      isMockLocation: rawPunches.isMockLocation,
    })
    .from(rawPunches)
    .innerJoin(shiftDevices, eq(rawPunches.deviceSerial, shiftDevices.serial))
    .where(
      and(
        eq(shiftDevices.deviceType, 'MOBILE'),
        gte(rawPunches.punchedAt, sql`${opts.from}::date`),
        lte(rawPunches.punchedAt, sql`(${opts.to}::date + 1)`),
        ...(opts.employeeCodes?.length
          ? [inArray(rawPunches.employeeCode, opts.employeeCodes)]
          : []),
      ),
    );

  if (rows.length === 0) return summary;

  // Mã địa điểm của từng thiết bị — một truy vấn thay vì N.
  const serials = [...new Set(rows.map((r) => r.deviceSerial))];
  const devs = await db
    .select({ serial: shiftDevices.serial, siteCode: shiftDevices.siteCode })
    .from(shiftDevices)
    .where(inArray(shiftDevices.serial, serials));
  const siteOf = new Map(devs.map((d) => [d.serial, d.siteCode]));

  const cache = new Map<string, GeofenceParams | null>();
  const rejected = new Map<string, number>();
  const noFenceSites = new Set<string>();
  const persist = opts.persist !== false;

  for (const r of rows) {
    summary.checked += 1;
    const siteCode = siteOf.get(r.deviceSerial) ?? null;
    // Ngày theo giờ VN — hàng rào đổi theo ngày nên phải dùng đúng ngày của quẹt.
    const at = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(r.punchedAt);

    let status: GeoStatus;
    let distanceM: number | null = null;
    let reasons: string[] = [];

    try {
      const fence = await fenceFor(db, siteCode, at, cache);
      const fix = gpsFixFromPunch(r);

      if (!fence) {
        status = 'NO_FENCE';
        if (siteCode) noFenceSites.add(siteCode);
      } else if (!fix) {
        status = 'NO_GPS';
      } else {
        const v = validateGpsPunch(fix, fenceFromParams(fence), configFromParams(fence));
        reasons = [...v.reasons];
        distanceM = v.distanceM;
        status = !v.ok ? 'REJECTED' : v.trusted ? 'TRUSTED' : 'REVIEW';
      }
    } catch (e) {
      // Một quẹt hỏng không được làm hỏng cả lần kiểm tra. Ghi lỗi và đi tiếp:
      // thà thiếu một kết luận còn hơn không có kết luận nào.
      summary.errors.push(`${r.employeeCode} ${r.punchedAt.toISOString()}: ${String(e)}`);
      continue;
    }

    summary.byStatus[status] += 1;
    if (status === 'REJECTED') {
      rejected.set(r.employeeCode, (rejected.get(r.employeeCode) ?? 0) + 1);
    }

    if (persist) {
      await db
        .update(rawPunches)
        .set({ geoStatus: status, geoDistanceM: distanceM, geoReasons: reasons })
        .where(eq(rawPunches.id, r.id));
    }
  }

  summary.sitesWithoutFence = [...noFenceSites].sort();
  summary.rejectedByEmployee = [...rejected.entries()]
    .map(([employeeCode, count]) => ({ employeeCode, count }))
    .sort((a, b) => b.count - a.count || a.employeeCode.localeCompare(b.employeeCode));

  return summary;
}

/**
 * Đếm quẹt theo trạng thái vị trí cho một khoảng ngày — để trang chấm công hiện
 * "có bao nhiêu quẹt đang chờ rà soát" mà không phải tải cả bảng.
 */
export async function geoStatusCounts(
  db: Db,
  from: string,
  to: string,
): Promise<Record<string, number>> {
  const rows = await db.execute(
    sql`select coalesce(geo_status, '(chưa kiểm tra)') as status, count(*)::int as n
        from raw_punches
        where punched_at >= ${from}::date
          and punched_at <  (${to}::date + 1)
        group by 1
        order by 2 desc`,
  );
  const out: Record<string, number> = {};
  for (const r of (rows as unknown as { rows: { status: string; n: number }[] }).rows) {
    out[r.status] = r.n;
  }
  return out;
}
