/**
 * ============================================================================
 * TEST SERVICE KIỂM TRA VỊ TRÍ — PostgreSQL thật
 * ============================================================================
 *
 * Mỗi test tạo HÀNG RÀO RIÊNG và THIẾT BỊ RIÊNG trong transaction của chính nó,
 * rồi rollback. Không dùng SITE_HQ của seed: một test chỉ pass nhờ DB đã seed thì
 * không phải test, nó là một cái bẫy — và bài học đó đã trả giá một lần ở
 * tests/attendance-service.spec.ts.
 *
 * Trọng tâm là những phân biệt mà nếu gộp lại thì hệ thống vẫn chạy nhưng nói dối:
 *   NO_GPS  ≠ REJECTED   (app không lấy được toạ độ ≠ người ta đứng sai chỗ)
 *   NO_FENCE ≠ REJECTED  (quản trị quên vẽ vùng ≠ người lao động gian lận)
 *   REVIEW  ≠ TRUSTED    (được chấm công nhưng cần người xem lại)
 *   máy cố định KHÔNG bị kiểm tra (nó không gửi GPS, và đó là bình thường)
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { employees, rawPunches, shiftDevices } = await import('../src/db/schema.js');
const { validatePunchLocations } = await import('../src/lib/location-check.js');
const { ensureKind, createVersion, activateVersion } = await import('../src/policy/registry.js');
const { geofenceParamsSchema, geofenceJsonSchema } = await import(
  '../src/policy/geofence-params.js'
);
const { eq } = await import('drizzle-orm');

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function rolled<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = getDb();
  let out: T | undefined;
  const MARK = 'ROLLBACK_LOCATION_TEST';
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

const TAG = `LC${Date.now()}`;
const HQ = { lat: 10.776889, lng: 106.700806 };
const M_PER_DEG_LAT = 111_320;

/** Dịch toạ độ về phía bắc `metres` mét. */
const north = (metres: number) => ({ lat: HQ.lat + metres / M_PER_DEG_LAT, lng: HQ.lng });

async function makeFence(tx: Tx, site: string, over: Record<string, unknown> = {}): Promise<void> {
  await ensureKind(
    { code: 'GEOFENCE', nameVi: 'Geofence', paramsSchema: geofenceJsonSchema, exclusiveByCode: true },
    tx,
  );
  const { versionId } = await createVersion(
    { kindCode: 'GEOFENCE', effectiveFrom: '2020-01-01', createdBy: 'test' },
    {
      regimeCode: site,
      regimeLabel: `Địa điểm thử ${site}`,
      centerLat: HQ.lat,
      centerLng: HQ.lng,
      hardRadiusM: 200,
      softRadiusM: 120,
      polygon: null,
      allowedBssids: [],
      maxAccuracyM: 65,
      requireWifiBssid: false,
      blockMockLocation: true,
      accuracyToleranceFactor: 1,
      ...over,
    },
    geofenceParamsSchema,
    tx,
  );
  await activateVersion(versionId, { id: 'test' }, tx);
}

async function makeDevice(
  tx: Tx,
  serial: string,
  opts: { siteCode?: string | null; deviceType?: 'MOBILE' | 'TERMINAL' } = {},
): Promise<void> {
  await tx.insert(shiftDevices).values({
    serial,
    model: 'Test',
    protocol: opts.deviceType === 'MOBILE' ? 'MOBILE' : 'HIK_ISAPI',
    location: 'Thử',
    siteCode: opts.siteCode === undefined ? `${TAG}_SITE` : opts.siteCode,
    deviceType: opts.deviceType ?? 'MOBILE',
    active: true,
  });
}

async function makeEmployee(tx: Tx, code: string): Promise<void> {
  await tx.insert(employees).values({
    employeeCode: code,
    fullName: 'Người Thử',
    department: 'Kỹ thuật',
    wageRegion: 'I',
    baseSalary: 10_000_000,
    dependents: 0,
    active: true,
  });
}

async function makePunch(
  tx: Tx,
  code: string,
  serial: string,
  at: string,
  opts: { lat?: number | null; lng?: number | null; accuracy?: number | null; mock?: boolean } = {},
): Promise<string> {
  const [p] = await tx
    .insert(rawPunches)
    .values({
      employeeCode: code,
      deviceSerial: serial,
      punchedAt: new Date(`${at}T08:00:00+07:00`),
      direction: 'IN',
      source: 'DEVICE',
      latitude: opts.lat === undefined ? HQ.lat : opts.lat,
      longitude: opts.lng === undefined ? HQ.lng : opts.lng,
      accuracyMeters: opts.accuracy === undefined ? 15 : opts.accuracy,
      isMockLocation: opts.mock ?? false,
    })
    .returning({ id: rawPunches.id });
  return p!.id;
}

async function statusOf(tx: Tx, id: string) {
  const [r] = await tx
    .select({
      geoStatus: rawPunches.geoStatus,
      geoDistanceM: rawPunches.geoDistanceM,
      geoReasons: rawPunches.geoReasons,
    })
    .from(rawPunches)
    .where(eq(rawPunches.id, id))
    .limit(1);
  return r!;
}

const DATE = '2026-09-15';

/**
 * Chạy kiểm tra CHỈ cho nhân viên của test này.
 *
 * Bản đầu tiên gọi thẳng `validatePunchLocations(tx, { from, to })` và assert số
 * đếm tuyệt đối. Nhưng query lấy MỌI quẹt từ thiết bị MOBILE trong khoảng ngày —
 * kể cả 411 quẹt thật do `seed:attendance` tạo. Kết quả là `byStatus.REJECTED`
 * ra 36 thay vì 1 và test đỏ vì dữ liệu của người khác, không phải vì code sai.
 * Đây đúng là bài học "một test dùng lại dữ liệu seed thì không phải test".
 */
function run(tx: Tx, code: string, from = DATE, to = DATE) {
  return validatePunchLocations(tx, { from, to, employeeCodes: [code] });
}

afterAll(async () => {
  await closeDb();
});

describe('validatePunchLocations — phân loại quẹt thẻ', () => {
  it('đứng gần, GPS tốt → TRUSTED', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T1`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T1`);
      await makeDevice(tx, `${TAG}_T1`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_T1`, `${TAG}_T1`, DATE, north(30));

      const s = await run(tx, `${TAG}_T1`);
      expect(s.checked).toBe(1);
      expect(s.byStatus.TRUSTED).toBe(1);
      expect((await statusOf(tx, id)).geoStatus).toBe('TRUSTED');
    });
  });

  it('trong bán kính cứng nhưng ngoài vùng mềm → REVIEW, KHÔNG phải TRUSTED', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T2`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T2`);
      await makeDevice(tx, `${TAG}_T2`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_T2`, `${TAG}_T2`, DATE, north(150));

      const s = await run(tx, `${TAG}_T2`);
      expect(s.byStatus.REVIEW).toBe(1);
      expect(s.byStatus.TRUSTED).toBe(0);
      // Vẫn được chấm công — REVIEW không nằm trong rejectedByEmployee.
      expect(s.rejectedByEmployee).toHaveLength(0);
      expect((await statusOf(tx, id)).geoStatus).toBe('REVIEW');
    });
  });

  it('ngoài bán kính cứng → REJECTED kèm lý do và khoảng cách', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T3`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T3`);
      await makeDevice(tx, `${TAG}_T3`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_T3`, `${TAG}_T3`, DATE, north(500));

      const s = await run(tx, `${TAG}_T3`);
      expect(s.byStatus.REJECTED).toBe(1);
      expect(s.rejectedByEmployee).toEqual([{ employeeCode: `${TAG}_T3`, count: 1 }]);

      const r = await statusOf(tx, id);
      expect(r.geoStatus).toBe('REJECTED');
      expect(r.geoReasons).toContain('OUTSIDE_HARD_RADIUS');
      expect(r.geoDistanceM).toBeGreaterThan(450);
      expect(r.geoDistanceM).toBeLessThan(550);
    });
  });

  it('mock location → REJECTED kể cả khi đứng đúng chỗ', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T4`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T4`);
      await makeDevice(tx, `${TAG}_T4`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_T4`, `${TAG}_T4`, DATE, { ...north(20), mock: true });

      await run(tx, `${TAG}_T4`);
      const r = await statusOf(tx, id);
      expect(r.geoStatus).toBe('REJECTED');
      expect(r.geoReasons).toContain('MOCK_LOCATION');
      // Khoảng cách vẫn được ghi: người ta ĐỨNG ĐÚNG CHỖ nhưng toạ độ là giả.
      // Hai thông tin đó phải cùng hiện ra, nếu không HR sẽ đi tìm một người
      // "đứng sai chỗ" không tồn tại.
      expect(r.geoDistanceM).toBeLessThan(60);
    });
  });

  it('GPS quá mờ → REJECTED với ACCURACY_TOO_LOW', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T5`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T5`);
      await makeDevice(tx, `${TAG}_T5`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_T5`, `${TAG}_T5`, DATE, { ...north(30), accuracy: 150 });

      await run(tx, `${TAG}_T5`);
      expect((await statusOf(tx, id)).geoReasons).toContain('ACCURACY_TOO_LOW');
    });
  });

  it('app KHÔNG lấy được toạ độ → NO_GPS, không phải REJECTED', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T6`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T6`);
      await makeDevice(tx, `${TAG}_T6`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_T6`, `${TAG}_T6`, DATE, { lat: null, lng: null });

      const s = await run(tx, `${TAG}_T6`);
      expect(s.byStatus.NO_GPS).toBe(1);
      expect(s.byStatus.REJECTED).toBe(0);
      // "App không lấy được GPS" là lỗi kỹ thuật; "đứng sai chỗ" là nghi vấn.
      // Gộp hai cái lại thì một lần iOS đổi quyền sẽ hiện ra thành hàng trăm vụ
      // gian lận, và không ai đọc nữa.
      expect(s.rejectedByEmployee).toHaveLength(0);
      expect((await statusOf(tx, id)).geoStatus).toBe('NO_GPS');
    });
  });

  it('thiết bị KHÔNG có siteCode → NO_FENCE', async () => {
    await rolled(async (tx) => {
      await makeEmployee(tx, `${TAG}_T7`);
      await makeDevice(tx, `${TAG}_T7`, { siteCode: null });
      const id = await makePunch(tx, `${TAG}_T7`, `${TAG}_T7`, DATE, north(30));

      const s = await run(tx, `${TAG}_T7`);
      expect(s.byStatus.NO_FENCE).toBe(1);
      // siteCode null thì không có "địa điểm" nào để nêu tên.
      expect(s.sitesWithoutFence).toEqual([]);
      expect((await statusOf(tx, id)).geoStatus).toBe('NO_FENCE');
    });
  });

  it('có siteCode nhưng CHƯA vẽ hàng rào → NO_FENCE và NÊU TÊN địa điểm', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T8`;
      await makeEmployee(tx, `${TAG}_T8`);
      await makeDevice(tx, `${TAG}_T8`, { siteCode: site });
      await makePunch(tx, `${TAG}_T8`, `${TAG}_T8`, DATE, north(30));

      const s = await run(tx, `${TAG}_T8`);
      expect(s.byStatus.NO_FENCE).toBe(1);
      expect(s.sitesWithoutFence).toEqual([site]);
      expect(s.byStatus.REJECTED).toBe(0);
    });
  });

  it('thiết bị CỐ ĐỊNH không bị kiểm tra — geoStatus giữ nguyên NULL', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_T9`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_T9`);
      await makeDevice(tx, `${TAG}_T9`, { siteCode: site, deviceType: 'TERMINAL' });
      const id = await makePunch(tx, `${TAG}_T9`, `${TAG}_T9`, DATE, { lat: null, lng: null });

      const s = await run(tx, `${TAG}_T9`);
      // Máy chấm công được bắt vít vào tường, vị trí của nó là hiển nhiên, và nó
      // không gửi toạ độ. Áp geofence cho nó thì MỌI quẹt đều thành NO_GPS — tức
      // là biến một hệ thống đang chạy đúng thành một danh sách cảnh báo vô nghĩa.
      expect(s.checked).toBe(0);
      expect((await statusOf(tx, id)).geoStatus).toBeNull();
    });
  });

  it('persist: false tính nhưng KHÔNG ghi', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_TA`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_TA`);
      await makeDevice(tx, `${TAG}_TA`, { siteCode: site });
      const id = await makePunch(tx, `${TAG}_TA`, `${TAG}_TA`, DATE, north(500));

      const s = await validatePunchLocations(tx, { from: DATE, to: DATE, employeeCodes: [`${TAG}_TA`], persist: false });
      expect(s.byStatus.REJECTED).toBe(1);
      expect((await statusOf(tx, id)).geoStatus).toBeNull();
    });
  });

  it('quẹt NGOÀI khoảng ngày không bị đụng tới', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_TB`;
      await makeFence(tx, site);
      await makeEmployee(tx, `${TAG}_TB`);
      await makeDevice(tx, `${TAG}_TB`, { siteCode: site });
      const inside = await makePunch(tx, `${TAG}_TB`, `${TAG}_TB`, '2026-09-15', north(500));
      const outside = await makePunch(tx, `${TAG}_TB`, `${TAG}_TB`, '2026-10-20', north(500));

      const s = await validatePunchLocations(tx, { from: '2026-09-01', to: '2026-09-30', employeeCodes: [`${TAG}_TB`] });
      expect(s.checked).toBe(1);
      expect((await statusOf(tx, inside)).geoStatus).toBe('REJECTED');
      expect((await statusOf(tx, outside)).geoStatus).toBeNull();
    });
  });

  it('hàng rào resolve theo NGÀY CỦA QUẸT, không theo ngày chạy script', async () => {
    await rolled(async (tx) => {
      const site = `${TAG}_TC`;
      // Hàng rào chỉ có hiệu lực từ 2026-09-10. Một quẹt ngày 05/09 phải thành
      // NO_FENCE dù hôm nay hàng rào đang hiệu lực — nếu không thì chạy lại
      // script vào tháng sau sẽ đánh giá lại quá khứ theo luật mới.
      await makeFence(tx, site);
      await tx.execute(
        (await import('drizzle-orm')).sql`update policy_versions
            set effective_from = '2026-09-10'
            where kind_code = 'GEOFENCE' and code = ${site}`,
      );
      await makeEmployee(tx, `${TAG}_TC`);
      await makeDevice(tx, `${TAG}_TC`, { siteCode: site });
      const before = await makePunch(tx, `${TAG}_TC`, `${TAG}_TC`, '2026-09-05', north(30));
      const after = await makePunch(tx, `${TAG}_TC`, `${TAG}_TC`, '2026-09-15', north(30));

      const s = await validatePunchLocations(tx, { from: '2026-09-01', to: '2026-09-30', employeeCodes: [`${TAG}_TC`] });
      expect(s.byStatus.NO_FENCE).toBe(1);
      expect(s.byStatus.TRUSTED).toBe(1);
      expect((await statusOf(tx, before)).geoStatus).toBe('NO_FENCE');
      expect((await statusOf(tx, after)).geoStatus).toBe('TRUSTED');
    });
  });
});
