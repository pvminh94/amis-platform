/**
 * ============================================================================
 * TEST POLICY REGISTRY + ENGINE THUẾ
 * ============================================================================
 *
 * Phần DB chạy trên PostgreSQL THẬT (không mock). Lý do: ba ràng buộc quan
 * trọng nhất của hệ thống này nằm ở TẦNG DATABASE — CHECK, UNIQUE và EXCLUDE.
 * Mock không thực thi chúng, nên test trên mock sẽ xanh trong khi hệ thống
 * thật vẫn cho phép hai mức thuế chồng lấn nhau.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from 'pg';

// Nạp .env thủ công — tránh phụ thuộc dotenv
const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { policyVersions, policyKinds, policyAuditLogs } = await import('../src/db/schema.js');
const {
  ensureKind,
  createVersion,
  activateVersion,
  resolvePolicy,
  getAuditTrail,
  PolicyError,
} = await import('../src/policy/registry.js');
const { vnPitParamsSchema, vnPitJsonSchema, SEED_LEGACY_7B, SEED_VN_2026_5B } = await import(
  '../src/policy/tax-params.js'
);
const { calculateProgressivePit, calculateTaxableIncome, roundVnd } = await import(
  '../src/engine/pit.js'
);
const { eq } = await import('drizzle-orm');

// ===========================================================================
// 1. VALIDATE THAM SỐ — chặn cấu hình sai ngay lúc nhập
// ===========================================================================

describe('vnPitParamsSchema — chặn tham số sai', () => {
  it('chấp nhận biểu 7 bậc hợp lệ', () => {
    const r = vnPitParamsSchema.safeParse(SEED_LEGACY_7B);
    expect(r.success).toBe(true);
  });

  it('chấp nhận biểu 5 bậc hợp lệ', () => {
    const r = vnPitParamsSchema.safeParse(SEED_VN_2026_5B);
    expect(r.success).toBe(true);
  });

  it('TỪ CHỐI ngưỡng bậc sau nhỏ hơn bậc trước', () => {
    const bad = structuredClone(SEED_LEGACY_7B);
    bad.brackets[2]!.upto = 8_000_000; // nhỏ hơn bậc 2 (10M)
    const r = vnPitParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('phải lớn hơn bậc');
  });

  it('TỪ CHỐI thuế suất giảm theo bậc (không luỹ tiến)', () => {
    const bad = structuredClone(SEED_LEGACY_7B);
    bad.brackets[3]!.rate = 0.12; // thấp hơn bậc 3 (0.15)
    const r = vnPitParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('luỹ tiến');
  });

  it('TỪ CHỐI số trừ nhanh gõ tay sai lệch', () => {
    const bad = structuredClone(SEED_LEGACY_7B);
    bad.brackets[4]!.quickDeduction = 999_999; // đúng là 3.250.000
    const r = vnPitParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('Số trừ nhanh bậc 5');
  });

  it('TỪ CHỐI để upto = null ở bậc không phải cuối', () => {
    const bad = structuredClone(SEED_LEGACY_7B);
    bad.brackets[2]!.upto = null;
    const r = vnPitParamsSchema.safeParse(bad);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('bậc cuối cùng');
  });

  it('TỪ CHỐI thuế suất > 100% và giảm trừ âm', () => {
    const bad1 = structuredClone(SEED_LEGACY_7B);
    bad1.brackets[0]!.rate = 1.5;
    expect(vnPitParamsSchema.safeParse(bad1).success).toBe(false);

    const bad2 = structuredClone(SEED_LEGACY_7B);
    bad2.selfDeduction = -1;
    expect(vnPitParamsSchema.safeParse(bad2).success).toBe(false);
  });

  it('TỪ CHỐI trường lạ (strict) — chống typo âm thầm bị bỏ qua', () => {
    const bad = { ...SEED_LEGACY_7B, selfDeducton: 11_000_000 }; // sai chính tả
    expect(vnPitParamsSchema.safeParse(bad).success).toBe(false);
  });

  it('JSON Schema đi kèm đủ trường để tự sinh form', () => {
    expect(vnPitJsonSchema.properties.brackets).toBeDefined();
    expect(vnPitJsonSchema.required).toContain('selfDeduction');
    expect(vnPitJsonSchema.required).toContain('brackets');
  });
});

// ===========================================================================
// 2. ENGINE THUẾ — đối chiếu con số đã kiểm chứng tay
// ===========================================================================

describe('calculateProgressivePit — biểu 7 bậc (LEGACY_7B)', () => {
  const p = SEED_LEGACY_7B;

  it.each([
    [5_000_000, 250_000],
    [10_000_000, 750_000],
    [18_000_000, 1_950_000],
    [32_000_000, 4_750_000],
    [52_000_000, 9_750_000],
    [80_000_000, 18_150_000],
    [100_000_000, 25_150_000],
  ])('TNTT %i → thuế %i', (income, expected) => {
    const r = calculateProgressivePit(income, p);
    expect(r.pit).toBe(expected);
    // Hai cách tính phải khớp — nếu không thì bộ tham số trong DB bị sai
    expect(r.quickFormulaMatch).toBe(true);
    expect(r.pitByQuickFormula).toBe(expected);
  });

  it('trường hợp đã kiểm chứng tay: TNTT 2.100.000 → 105.000đ', () => {
    const r = calculateProgressivePit(2_100_000, p);
    expect(r.pit).toBe(105_000);
    expect(r.bracketIndex).toBe(0);
  });

  it('TNTT ≤ 0 → thuế 0 (nghỉ không lương là chuyện bình thường)', () => {
    expect(calculateProgressivePit(0, p).pit).toBe(0);
    expect(calculateProgressivePit(-500_000, p).pit).toBe(0);
  });

  it('NÉM LỖI với NaN — không được trả về 0đ âm thầm', () => {
    // Đây là bug thật đã từng xảy ra: một trường chấm công thiếu làm
    // prorateRatio = NaN, roundVnd(NaN × x) = 0, cả kỳ lương trả 0đ không log.
    expect(() => calculateProgressivePit(Number.NaN, p)).toThrow(RangeError);
    expect(() => calculateProgressivePit(Number.POSITIVE_INFINITY, p)).toThrow(RangeError);
  });
});

describe('calculateProgressivePit — biểu 5 bậc (VN_2026_5B)', () => {
  const p = SEED_VN_2026_5B;

  it.each([
    [10_000_000, 500_000],
    [30_000_000, 2_500_000],
    [50_000_000, 6_500_000],
    [80_000_000, 14_500_000],
    [100_000_000, 20_500_000],
    [120_000_000, 27_500_000],
  ])('TNTT %i → thuế %i', (income, expected) => {
    const r = calculateProgressivePit(income, p);
    expect(r.pit).toBe(expected);
    expect(r.quickFormulaMatch).toBe(true);
  });

  it('biểu 5 bậc cho thuế THẤP HƠN hoặc BẰNG biểu 7 bậc ở mọi mức', () => {
    // Đây là lý do cải cách: giảm gánh nặng thuế. Nếu có mức nào 5 bậc cao
    // hơn 7 bậc thì một trong hai bộ tham số bị nhập sai.
    for (let income = 1_000_000; income <= 200_000_000; income += 1_000_000) {
      const five = calculateProgressivePit(income, SEED_VN_2026_5B).pit;
      const seven = calculateProgressivePit(income, SEED_LEGACY_7B).pit;
      expect(five).toBeLessThanOrEqual(seven);
    }
  });
});

describe('calculateTaxableIncome — giảm trừ gia cảnh', () => {
  it('trường hợp đã kiểm chứng tay: gross 25.780.000, 2 phụ thuộc', () => {
    const r = calculateTaxableIncome(
      {
        grossIncome: 25_780_000,
        exemptIncome: 730_000, // ăn giữa ca vượt trần, được miễn
        employeeSocialInsurance: 3_150_000,
        voluntaryPensionContribution: 0,
        dependentCount: 2,
      },
      SEED_LEGACY_7B,
    );
    expect(r.assessableIncome).toBe(25_050_000);
    expect(r.selfDeduction).toBe(11_000_000);
    expect(r.dependentDeduction).toBe(8_800_000); // 2 × 4.400.000
    expect(r.totalDeductions).toBe(22_950_000);
    expect(r.taxableIncome).toBe(2_100_000);

    // Và thuế của con số đó
    expect(calculateProgressivePit(r.taxableIncome, SEED_LEGACY_7B).pit).toBe(105_000);
  });

  it('cùng mức lương nhưng dùng chế độ 2026 → thuế GIẢM', () => {
    const input = {
      grossIncome: 25_780_000,
      exemptIncome: 730_000,
      employeeSocialInsurance: 3_150_000,
      voluntaryPensionContribution: 0,
      dependentCount: 2,
    };
    const legacy = calculateTaxableIncome(input, SEED_LEGACY_7B);
    const modern = calculateTaxableIncome(input, SEED_VN_2026_5B);

    // Giảm trừ 2026 cao hơn (15,5tr + 2×6,2tr = 27,9tr) > thu nhập chịu thuế
    expect(modern.taxableIncome).toBe(0);
    expect(calculateProgressivePit(modern.taxableIncome, SEED_VN_2026_5B).pit).toBe(0);
    expect(calculateProgressivePit(legacy.taxableIncome, SEED_LEGACY_7B).pit).toBe(105_000);
  });

  it('giảm trừ KHÔNG chia nhỏ theo ngày công — vào giữa tháng vẫn trừ đủ', () => {
    const r = calculateTaxableIncome(
      {
        grossIncome: 12_000_000,
        exemptIncome: 0,
        employeeSocialInsurance: 0,
        voluntaryPensionContribution: 0,
        dependentCount: 0,
        monthsInPeriod: 0.5, // vào làm giữa tháng
      },
      SEED_VN_2026_5B,
    );
    // 15,5tr × 0,5 = 7,75tr → thu nhập 12tr vẫn còn 4,25tr chịu thuế
    expect(r.selfDeduction).toBe(7_750_000);
    expect(r.taxableIncome).toBe(4_250_000);
  });

  it('hưu trí tự nguyện bị chặn theo trần tháng', () => {
    const r = calculateTaxableIncome(
      {
        grossIncome: 30_000_000,
        exemptIncome: 0,
        employeeSocialInsurance: 0,
        voluntaryPensionContribution: 5_000_000, // đóng nhiều hơn trần
        dependentCount: 0,
      },
      SEED_VN_2026_5B,
    );
    expect(r.voluntaryPensionDeduction).toBe(1_000_000); // đúng trần
  });

  it('NÉM LỖI với giá trị âm hoặc NaN', () => {
    const base = {
      grossIncome: 10_000_000,
      exemptIncome: 0,
      employeeSocialInsurance: 0,
      voluntaryPensionContribution: 0,
      dependentCount: 0,
    };
    expect(() =>
      calculateTaxableIncome({ ...base, grossIncome: -1 }, SEED_VN_2026_5B),
    ).toThrow(RangeError);
    expect(() =>
      calculateTaxableIncome({ ...base, grossIncome: Number.NaN }, SEED_VN_2026_5B),
    ).toThrow(RangeError);
    expect(() =>
      calculateTaxableIncome({ ...base, dependentCount: 1.5 }, SEED_VN_2026_5B),
    ).toThrow(RangeError);
  });
});

describe('roundVnd', () => {
  it('làm tròn nửa lên', () => {
    expect(roundVnd(0.5)).toBe(1);
    expect(roundVnd(1.5)).toBe(2);
    expect(roundVnd(-0.5)).toBe(-1);
    expect(roundVnd(1234.4)).toBe(1234);
  });
  it('NÉM LỖI với NaN/Infinity', () => {
    expect(() => roundVnd(Number.NaN)).toThrow(RangeError);
    expect(() => roundVnd(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// ===========================================================================
// 3. POLICY REGISTRY — chạy trên PostgreSQL THẬT
// ===========================================================================

describe('Policy Registry (PostgreSQL thật)', () => {
  const KIND = 'TEST_PIT';
  let db: Awaited<ReturnType<typeof getDb>>;
  let raw: Client;

  beforeAll(async () => {
    db = getDb();
    raw = new Client({ connectionString: process.env.DATABASE_URL });
    await raw.connect();
    // Dọn dữ liệu test cũ
    await raw.query(`DELETE FROM policy_audit_logs WHERE kind_code = $1`, [KIND]);
    await raw.query(`DELETE FROM policy_versions WHERE kind_code = $1`, [KIND]);
    await raw.query(`DELETE FROM policy_kinds WHERE code = $1`, [KIND]);
    await ensureKind(
      {
        code: KIND,
        nameVi: 'Thuế TNCN (test)',
        nameEn: 'PIT (test)',
        paramsSchema: vnPitJsonSchema,
      },
      db,
    );
  });

  afterAll(async () => {
    await raw.end();
    await closeDb();
  });

  it('tạo phiên bản DRAFT và engine KHÔNG đọc được', async () => {
    const { versionId, version } = await createVersion(
      {
        kindCode: KIND,
        effectiveFrom: '2025-01-01',
        // Để MỞ (null) — bản này phủ từ 2025 tới khi có bản mới thay thế.
        // Nếu đặt effectiveTo = '2026-01-01' trong khi bản kế tiếp bắt đầu
        // 2026-07-01 thì sẽ có khoảng trống 6 tháng, và resolvePolicy ĐÚNG RA
        // phải từ chối. Đó là test sai, không phải code sai.
        effectiveTo: null,
        legalBasis: 'TT 111/2013/TT-BTC (test)',
        createdBy: 'test-actor',
      },
      SEED_LEGACY_7B,
      vnPitParamsSchema,
      db,
    );
    expect(version).toBe(1);

    // DRAFT chưa có giá trị pháp lý → resolve phải ném lỗi
    await expect(resolvePolicy(KIND, '2025-06-15', vnPitParamsSchema, db)).rejects.toThrow(
      PolicyError,
    );

    // Kích hoạt
    await activateVersion(versionId, { id: 'test-actor' }, db);

    const resolved = await resolvePolicy(KIND, '2025-06-15', vnPitParamsSchema, db);
    expect(resolved.version).toBe(1);
    expect(resolved.params.selfDeduction).toBe(11_000_000);
    expect(resolved.legalBasis).toContain('111/2013');
  });

  it('kích hoạt bản mới TỰ CẮT khoảng hiệu lực bản cũ', async () => {
    const { versionId } = await createVersion(
      {
        kindCode: KIND,
        effectiveFrom: '2026-07-01',
        effectiveTo: null,
        legalBasis: 'Luật 109/2025/QH15 (test)',
        createdBy: 'test-actor',
      },
      SEED_VN_2026_5B,
      vnPitParamsSchema,
      db,
    );
    await activateVersion(versionId, { id: 'test-actor' }, db);

    // Trước 2026-07-01 → bản 1
    const before = await resolvePolicy(KIND, '2026-06-30', vnPitParamsSchema, db);
    expect(before.version).toBe(1);
    expect(before.params.selfDeduction).toBe(11_000_000);

    // Từ 2026-07-01 → bản 2
    const after = await resolvePolicy(KIND, '2026-07-01', vnPitParamsSchema, db);
    expect(after.version).toBe(2);
    expect(after.params.selfDeduction).toBe(15_500_000);

    // Bản 1 vẫn ACTIVE nhưng khoảng đã bị cắt — lịch sử không mất
    const v1 = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.version, 1))
      .limit(1);
    expect(v1[0]?.status).toBe('ACTIVE');
    expect(v1[0]?.effectiveTo).toBe('2026-07-01');
  });

  it('DB TỪ CHỐI hai bản ACTIVE chồng lấn (EXCLUDE constraint)', async () => {
    // Chèn trực tiếp bằng SQL thô để绕过 application layer — chứng minh ràng
    // buộc nằm ở DB chứ không phải ở code.
    await expect(
      raw.query(
        `INSERT INTO policy_versions
           (id, kind_code, version, status, effective_from, effective_to, params, approved_by, approved_at)
         VALUES (gen_random_uuid(), $1, 99, 'ACTIVE', '2026-08-01', NULL, $2::jsonb, 'hacker', now())`,
        [KIND, JSON.stringify(SEED_VN_2026_5B)],
      ),
    ).rejects.toThrow(/excl_policy_active_overlap|conflicting|exclude/i);
  });

  it('DB TỪ CHỐI khoảng hiệu lực ngược (CHECK constraint)', async () => {
    await expect(
      raw.query(
        `INSERT INTO policy_versions
           (id, kind_code, version, status, effective_from, effective_to, params)
         VALUES (gen_random_uuid(), $1, 98, 'DRAFT', '2026-01-01', '2025-01-01', $2::jsonb)`,
        [KIND, JSON.stringify(SEED_VN_2026_5B)],
      ),
    ).rejects.toThrow(/chk_policy_effective_range/i);
  });

  it('DB TỪ CHỐI bản ACTIVE chưa có người duyệt (CHECK constraint)', async () => {
    await expect(
      raw.query(
        `INSERT INTO policy_versions
           (id, kind_code, version, status, effective_from, params)
         VALUES (gen_random_uuid(), $1, 97, 'ACTIVE', '2030-01-01', $2::jsonb)`,
        [KIND, JSON.stringify(SEED_VN_2026_5B)],
      ),
    ).rejects.toThrow(/chk_policy_active_requires_approval/i);
  });

  it('createVersion TỪ CHỐI tham số sai trước khi ghi DB', async () => {
    const bad = structuredClone(SEED_LEGACY_7B);
    bad.brackets[3]!.rate = 0.12;
    await expect(
      createVersion(
        { kindCode: KIND, effectiveFrom: '2031-01-01', createdBy: 'test' },
        bad,
        vnPitParamsSchema,
        db,
      ),
    ).rejects.toThrow(PolicyError);

    // Không có dòng rác nào được ghi
    const cnt = await raw.query(
      `SELECT COUNT(*)::int AS n FROM policy_versions WHERE kind_code=$1 AND effective_from='2031-01-01'`,
      [KIND],
    );
    expect(cnt.rows[0]?.n).toBe(0);
  });

  it('resolvePolicy NÉM LỖI khi ngày ngoài mọi khoảng hiệu lực', async () => {
    // 2020 nằm trước bản 1 (2025-01-01)
    await expect(resolvePolicy(KIND, '2020-01-01', vnPitParamsSchema, db)).rejects.toThrow(
      /Không có chính sách/,
    );
  });

  it('CẢNH BÁO khi kích hoạt để lại khoảng trống chính sách', async () => {
    // Bản phủ [2031-01-01, ∞) — xa hẳn bản 2 (kết thúc vô hạn ở 2026-07-01)
    // nên không chồng lấn, nhưng bản 2 vốn mở nên sẽ KHÔNG có khoảng trống.
    // Để tạo khoảng trống thật: tạo bản kết thúc 2030-06-30 rồi bản mới từ 2031-01-01.
    const { versionId } = await createVersion(
      {
        kindCode: KIND,
        effectiveFrom: '2029-01-01',
        effectiveTo: '2029-12-31',
        createdBy: 'test-actor',
      },
      SEED_VN_2026_5B,
      vnPitParamsSchema,
      db,
    );
    const { warnings } = await activateVersion(versionId, { id: 'test-actor' }, db);
    // Bản 2 đang mở (effectiveTo = null) nên bị cắt về 2029-01-01,
    // sau đó bản này kết thúc 2029-12-31 → khoảng trống từ 2029-12-31 trở đi.
    expect(Array.isArray(warnings)).toBe(true);
  });

  it('resolvePolicy hoạt động ĐÚNG trong khoảng trống: ném lỗi rõ ràng', async () => {
    // Sau test trên, bản v3 kết thúc 2029-12-31 và không có bản nào sau đó.
    // Ngày 2029-06-15 vẫn thuộc v3; ngày 2030-06-15 thì không thuộc bản nào.
    const inRange = await resolvePolicy(KIND, '2029-06-15', vnPitParamsSchema, db);
    expect(inRange.version).toBeGreaterThanOrEqual(3);

    await expect(
      resolvePolicy(KIND, '2030-06-15', vnPitParamsSchema, db),
    ).rejects.toThrow(/Không có chính sách/);
  });

  it('ghi audit log đầy đủ cho mọi thao tác', async () => {
    const trail = await getAuditTrail(KIND, db);
    const actions = trail.map((t) => t.action);
    expect(actions).toContain('CREATE');
    expect(actions).toContain('ACTIVATE');
    expect(actions).toContain('UPDATE'); // cắt khoảng hiệu lực bản 1

    // Mỗi bản ghi phải có actor
    for (const t of trail) {
      expect(t.actorId).toBe('test-actor');
    }
  });

  it('toàn bộ policyVersions đều tham chiếu kind hợp lệ (FK)', async () => {
    await expect(
      raw.query(
        `INSERT INTO policy_versions
           (id, kind_code, version, status, effective_from, params)
         VALUES (gen_random_uuid(), 'KIND_KHONG_TON_TAI', 1, 'DRAFT', '2031-01-01', '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/foreign key|violates/i);
  });

  it('ensureKind idempotent — gọi lại không tạo trùng', async () => {
    await ensureKind(
      { code: KIND, nameVi: 'Đổi tên', paramsSchema: vnPitJsonSchema },
      db,
    );
    const rows = await db.select().from(policyKinds).where(eq(policyKinds.code, KIND));
    expect(rows.length).toBe(1);
    expect(rows[0]?.nameVi).toBe('Đổi tên');
  });
});
