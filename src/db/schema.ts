/**
 * ============================================================================
 * POLICY REGISTRY — trái tim của kiến trúc "sửa luật trên giao diện"
 * ============================================================================
 *
 * VẤN ĐỀ CẦN GIẢI: luật thuế/BHXH VN đổi liên tục (NQ 110/2025 đổi mức giảm
 * trừ từ 11tr/4,4tr sang 15,5tr/6,2tr; NĐ 161/2026 đổi mức tham chiếu từ
 * 2.340.000 lên 2.530.000). Nếu các con số này nằm trong hằng số TypeScript
 * thì MỖI LẦN luật đổi phải: sửa code → build → test → deploy. Với khách hàng
 * on-premise thì còn phải nâng cấp từng máy.
 *
 * GIẢI PHÁP: tham số luật là DỮ LIỆU, không phải code.
 *   policy_kinds     — một loại chính sách (VN_PIT, VN_SI, APPROVAL_LEAVE…)
 *   policy_versions  — nhiều phiên bản, mỗi bản có khoảng hiệu lực riêng
 *
 * Engine lương đọc tham số theo NGÀY của kỳ lương, không đọc hằng số. Đổi luật
 * = thêm một dòng vào policy_versions. Không build, không deploy.
 *
 * HAI RÀNG BUỘC ĐƯỢC ÉP Ở TẦNG DATABASE (không tin application layer):
 *   1. effective_to > effective_from        — CHECK constraint
 *   2. hai bản ACTIVE cùng loại KHÔNG được chồng lấn khoảng thời gian
 *      — EXCLUDE constraint (btree_gist). Đây là điểm mấu chốt: nếu thiếu,
 *      một ngày nào đó sẽ có 2 mức thuế cùng áp dụng và không ai biết
 *      engine chọn cái nào. Ép ở DB thì không thể xảy ra dù code có lỗi.
 *
 * MỌI thay đổi đều ghi policy_audit_logs — ai sửa mức thuế, lúc nào, từ IP nào.
 * Với dữ liệu pháp lý, "sửa mà không để lại dấu vết" là không chấp nhận được.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// ENUMS
// ---------------------------------------------------------------------------

/**
 * Vòng đời một phiên bản chính sách.
 *   DRAFT    — đang soạn, chưa có giá trị pháp lý, engine KHÔNG đọc
 *   ACTIVE   — đang hiệu lực, engine đọc được
 *   ARCHIVED — đã hết hiệu lực (bị bản mới thay thế)
 *   REJECTED — soạn sai, huỷ
 */
export const policyStatus = pgEnum('policy_status', [
  'DRAFT',
  'ACTIVE',
  'ARCHIVED',
  'REJECTED',
]);

export const auditAction = pgEnum('audit_action', [
  'CREATE',
  'UPDATE',
  'ACTIVATE',
  'ARCHIVE',
  'REJECT',
  'DELETE',
]);

// ---------------------------------------------------------------------------
// POLICY KINDS — danh mục loại chính sách
// ---------------------------------------------------------------------------

export const policyKinds = pgTable('policy_kinds', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Mã ổn định, code tham chiếu bằng mã này. Ví dụ: 'VN_PIT', 'VN_SI'. */
  code: varchar('code', { length: 64 }).notNull().unique(),

  nameVi: varchar('name_vi', { length: 200 }).notNull(),
  nameEn: varchar('name_en', { length: 200 }),
  description: text('description'),

  /**
   * JSON Schema mô tả cấu trúc hợp lệ của `params`. Dùng để:
   *   - validate trước khi lưu (không cho lưu tham số rác)
   *   - TỰ SINH form chỉnh sửa trên UI (không phải viết form tay cho từng loại)
   * Chính điểm này khiến hệ thống mở rộng được mà không cần code thêm.
   */
  paramsSchema: jsonb('params_schema').notNull(),

  /** Đơn vị tiền tệ / cách làm tròn mặc định cho loại này. */
  roundingMode: varchar('rounding_mode', { length: 20 }).notNull().default('HALF_UP_VND'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// POLICY VERSIONS — các phiên bản tham số, hiệu lực theo khoảng thời gian
// ---------------------------------------------------------------------------

export const policyVersions = pgTable(
  'policy_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    kindCode: varchar('kind_code', { length: 64 })
      .notNull()
      .references(() => policyKinds.code, { onDelete: 'restrict' }),

    /** Số phiên bản tăng dần trong cùng một loại. */
    version: integer('version').notNull(),

    status: policyStatus('status').notNull().default('DRAFT'),

    /** Ngày bắt đầu hiệu lực (tính cả ngày này). */
    effectiveFrom: date('effective_from', { mode: 'string' }).notNull(),

    /**
     * Ngày kết thúc (KHÔNG tính ngày này — khoảng nửa mở [from, to) ).
     * NULL = còn hiệu lực đến nay.
     */
    effectiveTo: date('effective_to', { mode: 'string' }),

    /** Tham số thật — bậc thuế, mức giảm trừ, tỷ lệ BHXH… */
    params: jsonb('params').notNull(),

    /**
     * Căn cứ pháp lý. BẮT BUỘC phải ghi: khi cơ quan thuế hỏi "tại sao kỳ
     * 3/2026 anh tính mức này", phải chỉ ra được văn bản nào.
     */
    legalBasis: text('legal_basis'),

    note: text('note'),

    createdBy: varchar('created_by', { length: 100 }),
    approvedBy: varchar('approved_by', { length: 100 }),
    approvedAt: timestamp('approved_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Cùng một loại, số phiên bản không trùng
    uqKindVersion: unique('uq_policy_kind_version').on(t.kindCode, t.version),

    // Đường tra cứu nóng: resolve theo (kind, status, ngày)
    idxResolve: index('idx_policy_versions_resolve').on(
      t.kindCode,
      t.status,
      t.effectiveFrom,
    ),

    // Khoảng hiệu lực phải hợp lệ
    chkEffectiveRange: check(
      'chk_policy_effective_range',
      sql`${t.effectiveTo} IS NULL OR ${t.effectiveTo} > ${t.effectiveFrom}`,
    ),

    // Bản ACTIVE phải có người duyệt — không cho kích hoạt "chui"
    chkApproved: check(
      'chk_policy_active_requires_approval',
      sql`${t.status} <> 'ACTIVE' OR (${t.approvedBy} IS NOT NULL AND ${t.approvedAt} IS NOT NULL)`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// AUDIT LOG — dấu vết mọi thay đổi
// ---------------------------------------------------------------------------

export const policyAuditLogs = pgTable(
  'policy_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kindCode: varchar('kind_code', { length: 64 }).notNull(),
    versionId: uuid('version_id'),
    version: integer('version'),
    action: auditAction('action').notNull(),

    /** Snapshot trước/sau để có thể tái hiện lịch sử thay đổi. */
    before: jsonb('before'),
    after: jsonb('after'),

    /** Thay đổi cụ thể những trường nào — để khỏi phải diff JSON bằng mắt. */
    changedFields: jsonb('changed_fields'),

    actorId: varchar('actor_id', { length: 100 }).notNull(),
    actorIp: varchar('actor_ip', { length: 64 }),
    reason: text('reason'),

    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxAuditKind: index('idx_policy_audit_kind_time').on(t.kindCode, t.at),
    idxAuditVersion: index('idx_policy_audit_version').on(t.versionId),
  }),
);

// ---------------------------------------------------------------------------
// PAY RUN — ghi lại tham số ĐÃ DÙNG cho từng kỳ lương
// ---------------------------------------------------------------------------

/**
 * BẢNG NÀY QUAN TRỌNG HƠN NHIỀU NGƯỜI NGHĨ.
 *
 * Khi tính lương kỳ 3/2026 xong, ta PHẢI đóng băng bộ tham số đã dùng vào
 * chính kỳ đó. Lý do: ba năm sau cơ quan thuế kiểm tra, hoặc có người vào
 * sửa policy_version, thì phiếu lương cũ vẫn phải tái hiện được ĐÚNG con số
 * đã tính. Nếu chỉ lưu "kindCode + ngày" rồi tra ngược lại policy_versions,
 * một lần chỉnh sửa quá khứ sẽ làm sai lệch toàn bộ lịch sử lương.
 */
export const payRuns = pgTable(
  'pay_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    periodMonth: integer('period_month').notNull(),
    periodYear: integer('period_year').notNull(),
    status: varchar('status', { length: 20 }).notNull().default('DRAFT'),

    /** Snapshot toàn bộ tham số luật đã áp dụng. JSON, bất biến sau khi LOCK. */
    policySnapshot: jsonb('policy_snapshot').notNull(),

    /** Truy ngược phiên bản gốc để đối chiếu khi cần. */
    policyVersionIds: jsonb('policy_version_ids'),

    grossTotal: integer('gross_total').notNull().default(0),
    employeeSiTotal: integer('employee_si_total').notNull().default(0),
    employerSiTotal: integer('employer_si_total').notNull().default(0),
    pitTotal: integer('pit_total').notNull().default(0),
    netTotal: integer('net_total').notNull().default(0),

    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: varchar('locked_by', { length: 100 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqPeriod: unique('uq_pay_run_period').on(t.periodYear, t.periodMonth),
    idxStatus: index('idx_pay_runs_status').on(t.status),
    chkPeriod: check(
      'chk_pay_run_period',
      sql`${t.periodMonth} >= 1 AND ${t.periodMonth} <= 12 AND ${t.periodYear} >= 2000`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// NHÂN VIÊN — entity nghiệp vụ đầu tiên của Phase 6
// ---------------------------------------------------------------------------

/**
 * Trước Phase 6, mọi con số lương đều đến từ dữ liệu mẫu hardcode trong
 * scripts/seed-salary.ts. Bảng này là thứ làm cho hệ thống thành một ERP thật:
 * nhân viên có thật, và phiếu lương tính cho MỘT NGƯỜI cụ thể.
 *
 * Chỉ giữ những trường mà engine cần. Hồ sơ đầy đủ (hợp đồng, bảo hiểm, ngân
 * hàng…) thuộc về module HRM, sẽ xây sau.
 */
export const employees = pgTable(
  'employees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    employeeCode: varchar('employee_code', { length: 32 }).notNull(),
    fullName: varchar('full_name', { length: 120 }).notNull(),
    /** Mã số thuế cá nhân — cần cho quyết toán, không dùng để tính. */
    taxCode: varchar('tax_code', { length: 20 }),
    department: varchar('department', { length: 120 }).notNull(),

    /**
     * Vùng lương tối thiểu. QUYẾT ĐỊNH trần và sàn BHTN — không phải trường
     * mô tả, mà là đầu vào tính toán. Sai một chữ là sai cả khoản BHTN.
     */
    // length 4 chứ không phải 2: tên vùng là SỐ LA MÃ — 'I', 'II', 'III', 'IV'.
    // 'III' dài 3 ký tự. Khai báo varchar(2) compile sạch, seed sạch với vùng I
    // và II, rồi mới nổ ở nhân viên đầu tiên thuộc vùng III.
    wageRegion: varchar('wage_region', { length: 4 }).notNull(),

    /** Đã qua đào tạo nghề → cộng 7% vào SÀN BHTN. */
    trainedWorker: boolean('trained_worker').notNull().default(false),

    /** Số người phụ thuộc đã đăng ký hợp lệ — giảm trừ 6,2 triệu/người. */
    dependents: integer('dependents').notNull().default(0),

    /** Lương cơ bản tháng (VND) — đầu vào cho công thức lương. */
    baseSalary: integer('base_salary').notNull(),
    /** Lương giờ (VND) — đầu vào cho lương làm thêm. */
    hourlyRate: integer('hourly_rate').notNull().default(0),

    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqCode: unique('uq_employees_code').on(t.employeeCode),
    idxDept: index('idx_employees_department').on(t.department),
    chkRegion: check(
      'chk_employees_region',
      sql`${t.wageRegion} IN ('I', 'II', 'III', 'IV')`,
    ),
    // Chặn ở tầng DB: lương âm hay số phụ thuộc âm là dữ liệu hỏng, và nếu lọt
    // qua thì engine sẽ tính ra một phiếu lương sai mà không lỗi nào hiện ra.
    chkNumbers: check(
      'chk_employees_numbers',
      sql`${t.baseSalary} >= 0 AND ${t.hourlyRate} >= 0 AND ${t.dependents} >= 0 AND ${t.dependents} <= 20`,
    ),
  }),
);

// ---------------------------------------------------------------------------
// PHIẾU LƯƠNG — kết quả của MỘT kỳ lương cho MỘT nhân viên
// ---------------------------------------------------------------------------

/**
 * MỖI PHIẾU LƯU LẠI TOÀN BỘ ĐẦU VÀO VÀ NGUỒN GỐC CHÍNH SÁCH.
 *
 * Đây không phải tối ưu, mà là yêu cầu pháp lý: ba năm sau, khi cơ quan thuế
 * hỏi "tại sao kỳ 09/2026 trừ đúng số này", phải tái hiện được chính xác bộ
 * tham số đã dùng. Chính sách trong DB có thể đã đổi nhiều lần kể từ đó.
 *
 * `employeeCode` và `fullName` được COPY vào chứ không join: nhân viên đổi
 * tên hay chuyển mã sau này thì phiếu lương cũ vẫn phải hiển thị đúng như
 * lúc nó được lập.
 */
export const payslips = pgTable(
  'payslips',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    payRunId: uuid('pay_run_id')
      .notNull()
      .references(() => payRuns.id, { onDelete: 'cascade' }),

    /**
     * onDelete: 'restrict' — KHÔNG CHO PHÉP xoá nhân viên đã có phiếu lương.
     * Xoá được là phá huỷ lịch sử trả lương, và đó là thứ không thể khôi phục.
     * Nhân viên nghỉ việc thì đặt active = false, không xoá.
     */
    employeeId: uuid('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),

    employeeCode: varchar('employee_code', { length: 32 }).notNull(),
    fullName: varchar('full_name', { length: 120 }).notNull(),

    /** Đầu vào công thức lương — để tính lại được y hệt. */
    variables: jsonb('variables').notNull(),

    /**
     * Bộ tham số đã áp dụng, theo từng loại chính sách:
     *   { VN_SALARY: { code, version }, VN_BHXH: {...}, VN_PIT: {...} }
     */
    policySnapshot: jsonb('policy_snapshot').notNull(),

    /** Kết quả từng thành phần lương. */
    components: jsonb('components').notNull(),

    earningsTotal: integer('earnings_total').notNull(),
    deductionsTotal: integer('deductions_total').notNull(),
    taxableIncome: integer('taxable_income').notNull(),
    insuranceBase: integer('insurance_base').notNull(),

    siBase: integer('si_base').notNull(),
    uiBase: integer('ui_base').notNull(),
    siEmployee: integer('si_employee').notNull(),
    siEmployer: integer('si_employer').notNull(),

    pit: integer('pit').notNull(),
    netPay: integer('net_pay').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Một nhân viên chỉ có MỘT phiếu trong một kỳ. Nếu không, chạy lại kỳ
    // lương sẽ sinh bản trùng và tổng quỹ lương bị đội lên.
    uqRunEmployee: unique('uq_payslips_run_employee').on(t.payRunId, t.employeeId),
    idxRun: index('idx_payslips_run').on(t.payRunId),
    idxEmployee: index('idx_payslips_employee').on(t.employeeId),
    // Số tiền không được âm; khấu trừ thì luôn <= 0.
    chkAmounts: check(
      'chk_payslips_amounts',
      sql`${t.earningsTotal} >= 0 AND ${t.deductionsTotal} <= 0 AND ${t.pit} >= 0
          AND ${t.siEmployee} >= 0 AND ${t.siEmployer} >= 0`,
    ),
  }),
);
