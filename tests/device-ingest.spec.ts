/**
 * ============================================================================
 * TEST SERVICE NHẬN QUẸT TỪ THIẾT BỊ — PostgreSQL thật
 * ============================================================================
 *
 * Mỗi test tạo thiết bị và nhân viên RIÊNG trong transaction rồi rollback.
 *
 * Ba điều cần khoá chặt:
 *   - khử trùng lặp phải dựa vào ràng buộc DB, không phải "đọc rồi mới ghi"
 *   - số thẻ không khớp ai thì phải NÊU LÊN, không bỏ qua im lặng
 *   - ba lý do từ chối thiết bị phải là BA MÃ khác nhau, vì ba cách xử lý khác nhau
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { employees, rawPunches, shiftDevices } = await import('../src/db/schema.js');
const {
  authenticateDevice,
  DeviceIngestError,
  ingestPunches,
  safeEqual,
} = await import('../src/lib/device-ingest.js');
// `await import()` cho ra GIÁ TRỊ, không phải kiểu — nên `catch (e as DeviceIngestErrorT)`
// nổ TS2749. Phải import riêng bằng `import type`. Đây là lần thứ hai repo này gặp
// đúng lỗi đó; nó dễ tái phạm vì `await import()` trông y hệt một import thường.
import type { DeviceIngestError as DeviceIngestErrorT } from '../src/lib/device-ingest.js';
const { eq } = await import('drizzle-orm');

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function rolled<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = getDb();
  let out: T | undefined;
  const MARK = 'ROLLBACK_DEVICE_TEST';
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

const TAG = `DI${Date.now()}`;

async function makeDevice(
  tx: Tx,
  serial: string,
  opts: { key?: string | null; active?: boolean } = {},
): Promise<void> {
  await tx.insert(shiftDevices).values({
    serial,
    model: 'Test',
    protocol: 'ZK_ADMS',
    location: 'Thử',
    deviceType: 'TERMINAL',
    webhookKey: opts.key === undefined ? `${TAG}-KEY` : opts.key,
    active: opts.active ?? true,
  });
}

async function makePerson(tx: Tx, code: string, deviceUserId: string | null): Promise<void> {
  await tx.insert(employees).values({
    employeeCode: code,
    fullName: 'Người Thử',
    department: 'Kỹ thuật',
    wageRegion: 'I',
    baseSalary: 10_000_000,
    deviceUserId,
    active: true,
  });
}

const at = (s: string) => new Date(`${s}T01:00:00.000Z`);

afterAll(async () => {
  await closeDb();
});

describe('safeEqual', () => {
  it('khớp đúng, lệch thì sai, và không nổ khi độ dài khác nhau', () => {
    // `timingSafeEqual` của Node NÉM nếu hai buffer khác độ dài — nếu không chặn
    // trước thì một khoá sai độ dài sẽ thành HTTP 500 thay vì 401, và người cấu
    // hình sai sẽ đi tìm lỗi ở chỗ không có lỗi.
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'ab')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
  });
});

describe('authenticateDevice — ba lý do từ chối phải là ba mã', () => {
  it('máy chưa đăng ký → UNKNOWN_DEVICE', async () => {
    await rolled(async (tx) => {
      await expect(authenticateDevice(tx, `${TAG}-KHONG-TON-TAI`, 'x')).rejects.toMatchObject({
        code: 'UNKNOWN_DEVICE',
      });
    });
  });

  it('khoá sai → BAD_KEY', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-D1`);
      await expect(authenticateDevice(tx, `${TAG}-D1`, 'sai-khoa')).rejects.toBeInstanceOf(
        DeviceIngestError,
      );
      try {
        await authenticateDevice(tx, `${TAG}-D1`, 'sai-khoa');
      } catch (e) {
        expect((e as DeviceIngestErrorT).code).toBe('BAD_KEY');
      }
    });
  });

  it('máy CHƯA được cấp khoá → cũng BAD_KEY, không phải 500', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-D2`, { key: null });
      try {
        await authenticateDevice(tx, `${TAG}-D2`, 'bat-ky');
        expect.unreachable('phải ném');
      } catch (e) {
        // Cùng một mã cho "chưa cấp khoá" và "khoá sai": nói rõ hơn là giúp
        // người dò khoá biết mình đang tiến gần.
        expect((e as DeviceIngestErrorT).code).toBe('BAD_KEY');
      }
    });
  });

  it('máy đã ngừng dùng → DEVICE_INACTIVE', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-D3`, { active: false });
      try {
        await authenticateDevice(tx, `${TAG}-D3`, `${TAG}-KEY`);
        expect.unreachable('phải ném');
      } catch (e) {
        expect((e as DeviceIngestErrorT).code).toBe('DEVICE_INACTIVE');
      }
    });
  });

  it('thiếu serial → NO_DEVICE_ID', async () => {
    await rolled(async (tx) => {
      try {
        await authenticateDevice(tx, '', 'x');
        expect.unreachable('phải ném');
      } catch (e) {
        expect((e as DeviceIngestErrorT).code).toBe('NO_DEVICE_ID');
      }
    });
  });

  it('đúng serial + đúng khoá → trả về siteCode và deviceType', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-D4`);
      const d = await authenticateDevice(tx, `${TAG}-D4`, `${TAG}-KEY`);
      expect(d.serial).toBe(`${TAG}-D4`);
      expect(d.deviceType).toBe('TERMINAL');
    });
  });
});

describe('ingestPunches', () => {
  it('ghi quẹt và ánh xạ số thẻ → mã nhân sự', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-I1`);
      await makePerson(tx, `${TAG}-NV1`, '9001');

      const r = await ingestPunches(tx, `${TAG}-I1`, [
        { deviceUserId: '9001', punchedAt: at('2026-09-15'), verifyMethod: 'FACE' },
      ]);
      expect(r.inserted).toBe(1);
      expect(r.duplicates).toBe(0);
      expect(r.unmatched).toEqual([]);

      const [row] = await tx
        .select({ code: rawPunches.employeeCode, vm: rawPunches.verifyMethod, src: rawPunches.source })
        .from(rawPunches)
        .where(eq(rawPunches.deviceSerial, `${TAG}-I1`));
      expect(row!.code).toBe(`${TAG}-NV1`);
      expect(row!.vm).toBe('FACE');
      expect(row!.src).toBe('DEVICE');
    });
  });

  it('gửi lại cùng một quẹt → duplicates++, KHÔNG ghi đôi', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-I2`);
      await makePerson(tx, `${TAG}-NV2`, '9002');
      const rec = [{ deviceUserId: '9002', punchedAt: at('2026-09-15') }];

      expect((await ingestPunches(tx, `${TAG}-I2`, rec)).inserted).toBe(1);
      const again = await ingestPunches(tx, `${TAG}-I2`, rec);
      expect(again.inserted).toBe(0);
      expect(again.duplicates).toBe(1);

      // Máy ADMS gửi lại log mỗi lần mất mạng. Nếu khử trùng lặp bằng "đọc xem có
      // chưa rồi mới ghi" thì hai lần gửi gần như đồng thời sẽ lọt qua cả hai.
      const [cnt] = await tx
        .select({ n: rawPunches.id })
        .from(rawPunches)
        .where(eq(rawPunches.deviceSerial, `${TAG}-I2`));
      const all = await tx
        .select({ id: rawPunches.id })
        .from(rawPunches)
        .where(eq(rawPunches.deviceSerial, `${TAG}-I2`));
      expect(all).toHaveLength(1);
      expect(cnt).toBeDefined();
    });
  });

  it('số thẻ KHÔNG khớp ai → nêu rõ trong unmatched, không bỏ qua im lặng', async () => {
    await rolled(async (tx) => {
      await makeDevice(tx, `${TAG}-I3`);
      await makePerson(tx, `${TAG}-NV3`, '9003');

      const r = await ingestPunches(tx, `${TAG}-I3`, [
        { deviceUserId: '9003', punchedAt: at('2026-09-15') },
        { deviceUserId: '7777', punchedAt: at('2026-09-15') },
        { deviceUserId: '7777', punchedAt: at('2026-09-16') },
        { deviceUserId: '8888', punchedAt: at('2026-09-15') },
      ]);
      expect(r.inserted).toBe(1);
      // Một máy vừa được nạp lại vân tay với dãy PIN mới sẽ sinh ra hàng trăm quẹt
      // "không biết của ai". Đó là thông tin phải thấy NGAY, không phải ba tuần
      // sau khi bảng lương thiếu người.
      expect(r.unmatched).toEqual([
        { deviceUserId: '7777', count: 2 },
        { deviceUserId: '8888', count: 1 },
      ]);
    });
  });

  it('batch rỗng → không truy vấn, không lỗi', async () => {
    await rolled(async (tx) => {
      const r = await ingestPunches(tx, `${TAG}-I4`, []);
      expect(r).toMatchObject({ received: 0, inserted: 0, duplicates: 0, unmatched: [] });
    });
  });

  it('quẹt bị máy từ chối được đếm riêng, không thành quẹt', async () => {
    await rolled(async (tx) => {
      const r = await ingestPunches(tx, `${TAG}-I5`, [], { source: 'DEVICE', rejectedByDevice: 1 });
      expect(r.rejectedByDevice).toBe(1);
      expect(r.inserted).toBe(0);
    });
  });
});

describe('employees.device_user_id — unique từng phần', () => {
  it('hai nhân viên KHÔNG được trùng số thẻ', async () => {
    await rolled(async (tx) => {
      await makePerson(tx, `${TAG}-U1`, '6001');
      let code = '';
      try {
        await makePerson(tx, `${TAG}-U2`, '6001');
      } catch (e) {
        code = (e as { code?: string }).code ?? '';
      }
      // 23505 = unique_violation. Nếu ràng buộc này không tồn tại thì hai người
      // cùng một số thẻ, và mọi quẹt của số đó sẽ được ghi cho người nào trùng
      // trước — một kiểu chấm công nhầm không có cách nào phát hiện về sau.
      expect(code).toBe('23505');
    });
  });

  it('nhiều nhân viên cùng để TRỐNG số thẻ thì không xung đột', async () => {
    await rolled(async (tx) => {
      // Nếu để UNIQUE thường (không phải unique index từng phần) thì dòng thứ hai
      // có device_user_id NULL sẽ nổ ràng buộc — và "không dùng máy chấm công" là
      // trạng thái hợp lệ của đa số nhân viên văn phòng.
      await makePerson(tx, `${TAG}-U3`, null);
      await makePerson(tx, `${TAG}-U4`, null);
      await makePerson(tx, `${TAG}-U5`, null);
      const all = await tx
        .select({ code: employees.employeeCode })
        .from(employees)
        .where(eq(employees.department, 'Kỹ thuật'));
      expect(all.length).toBeGreaterThanOrEqual(3);
    });
  });
});
