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

  /**
   * Phạm vi độc quyền của phiên bản ACTIVE.
   *
   *   false — độc quyền theo KIND. Đúng cho THAM SỐ LUẬT: tại một thời điểm chỉ
   *           có MỘT biểu thuế TNCN có hiệu lực, dù nó mang mã chế độ nào.
   *   true  — độc quyền theo CODE. Đúng cho ĐỊNH NGHĨA: phải có nhiều mẫu in và
   *           nhiều báo cáo cùng ACTIVE một lúc (phiếu lương, bảng chấm công,
   *           UNC…), mỗi cái có lịch sử phiên bản riêng.
   *
   * Không có cờ này thì hai mẫu in không thể cùng tồn tại — ràng buộc
   * EXCLUDE sẽ archive mẫu cũ ngay khi kích hoạt mẫu mới.
   */
  exclusiveByCode: boolean('exclusive_by_code').notNull().default(false),

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

    /**
     * Mã của THỰC THỂ cụ thể trong loại: tên chế độ thuế, mã mẫu in, mã báo cáo.
     * Lấy từ `params.regimeCode` lúc tạo phiên bản.
     */
    code: varchar('code', { length: 64 }).notNull().default(''),

    /** Số phiên bản tăng dần trong cùng một (loại, mã). */
    version: integer('version').notNull(),

    /**
     * Sao chép từ policy_kinds.exclusive_by_code lúc tạo.
     *
     * Phải nằm TRÊN DÒNG NÀY vì ràng buộc EXCLUDE chỉ đọc được cột của chính
     * bảng nó — không join sang policy_kinds được.
     */
    exclusiveByCode: boolean('exclusive_by_code').notNull().default(false),

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
    // Cùng một (loại, mã), số phiên bản không trùng.
    // Thêm `code` vào khoá: hai báo cáo khác nhau đều có v1, v2…
    uqKindCodeVersion: unique('uq_policy_kind_code_version').on(
      t.kindCode,
      t.code,
      t.version,
    ),
    // KHÔNG giữ uq_policy_kind_version(kind_code, version).
    //
    // Đã thử giữ "cho an toàn" và nó nổ ngay: hai báo cáo khác nhau đều bắt
    // đầu ở v1 nên (REPORT_DEF, 1) xuất hiện hai lần. Ràng buộc cũ mã hoá đúng
    // giả định mà cột `code` sinh ra để bỏ — rằng một loại chỉ có một chuỗi
    // phiên bản. Giữ nó nghĩa là cột code vô dụng.

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

// ---------------------------------------------------------------------------
// ĐƠN XIN DUYỆT + AUDIT TRAIL (Phase 4)
// ---------------------------------------------------------------------------

/**
 * Một đơn xin duyệt. Đa hình: `docType` + `docRef` trỏ tới tài liệu gốc
 * (kỳ lương, đơn nghỉ, phiếu chi…) mà không cần một bảng cho mỗi loại.
 */
export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** PAYRUN | LEAVE | EXPENSE | REGULARIZATION | BUSINESS_TRIP … */
    docType: varchar('doc_type', { length: 40 }).notNull(),
    /** id của tài liệu gốc. Không FK vì mỗi loại nằm ở một bảng khác. */
    docRef: uuid('doc_ref').notNull(),
    /** Nhãn hiển thị, ví dụ "Bảng lương 09/2026". */
    docLabel: varchar('doc_label', { length: 200 }).notNull(),

    /**
     * Số tiền của đơn — dùng cho ngưỡng duyệt. NULL với đơn không có tiền
     * (nghỉ phép tính bằng ngày). KHÔNG mặc định 0: một đơn thiếu tiền mà
     * thành 0 đồng sẽ lọt qua mọi ngưỡng.
     */
    amount: integer('amount'),

    /**
     * Ngữ cảnh để đánh giá điều kiện bước (days, hours, type, amount…).
     * Engine đọc thẳng object này.
     */
    context: jsonb('context').notNull(),

    /**
     * CHUỖI DUYỆT ĐÃ PHÂN GIẢI, chụp lúc nộp đơn.
     *
     * Bắt buộc phải chụp. Nếu đọc lại từ chính sách APPROVAL mỗi lần hiển thị,
     * một thay đổi ngưỡng giữa chừng sẽ đổi số bước của một đơn đang duyệt dở —
     * đơn đang ở "bước 2/3" bỗng thành "bước 2/2" và tự chốt.
     */
    chain: jsonb('chain').notNull(),
    /** Bộ tham số đã dùng để dựng chuỗi — để đối chiếu sau này. */
    policySnapshot: jsonb('policy_snapshot').notNull(),

    state: varchar('state', { length: 20 }).notNull().default('DRAFT'),
    /** Bước hiện tại, 0-based. */
    currentStep: integer('current_step').notNull().default(0),
    totalSteps: integer('total_steps').notNull(),

    requestedBy: varchar('requested_by', { length: 100 }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Một tài liệu chỉ có một đơn duyệt. Hai đơn song song cho cùng một kỳ
    // lương thì không biết cái nào có giá trị.
    uqDoc: unique('uq_approval_requests_doc').on(t.docType, t.docRef),
    idxState: index('idx_approval_requests_state').on(t.state),
    chkState: check(
      'chk_approval_requests_state',
      sql`${t.state} IN ('DRAFT','SUBMITTED','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED','RETURNED')`,
    ),
    chkSteps: check(
      'chk_approval_requests_steps',
      sql`${t.totalSteps} >= 1 AND ${t.currentStep} >= 0 AND ${t.currentStep} <= ${t.totalSteps}`,
    ),
    chkAmount: check('chk_approval_requests_amount', sql`${t.amount} IS NULL OR ${t.amount} >= 0`),
  }),
);

/**
 * Audit trail — CHỈ CÓ INSERT.
 *
 * Bất biến được ép ở TẦNG DATABASE bằng trigger trong extras.sql, không chỉ
 * bằng quy ước trong code. Một audit trail mà ai có quyền DB cũng sửa được thì
 * không phải audit trail.
 */
export const approvalAudit = pgTable(
  'approval_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    requestId: uuid('request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),

    action: varchar('action', { length: 20 }).notNull(),
    fromStatus: varchar('from_status', { length: 20 }).notNull(),
    toStatus: varchar('to_status', { length: 20 }).notNull(),
    step: integer('step'),

    actorId: varchar('actor_id', { length: 100 }),
    actorName: varchar('actor_name', { length: 200 }),
    actorRole: varchar('actor_role', { length: 60 }),
    comment: text('comment'),

    ipAddress: varchar('ip_address', { length: 45 }).notNull(),
    userAgent: text('user_agent'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    idxRequest: index('idx_approval_audit_request').on(t.requestId),
  }),
);

// ===========================================================================
// AUTH + RBAC (Phase 7)
// ===========================================================================

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    username: varchar('username', { length: 60 }).notNull(),
    /**
     * bcrypt, salt 10.
     *
     * Salt 10 là đánh đổi có ý thức: ~100ms mỗi lần băm trên phần cứng hiện
     * đại — đủ chậm để brute-force đắt, đủ nhanh để đăng nhập không khó chịu.
     * Tăng lên 12 sẽ nhân bốn thời gian và làm nghẽn luồng đăng nhập khi có
     * burst; nếu cần mạnh hơn thì đổi thuật toán (argon2id) chứ không tăng salt.
     */
    passwordHash: varchar('password_hash', { length: 100 }).notNull(),
    fullName: varchar('full_name', { length: 120 }).notNull(),
    email: varchar('email', { length: 200 }),
    department: varchar('department', { length: 120 }),
    branch: varchar('branch', { length: 120 }),

    active: boolean('active').notNull().default(true),
    /** Bắt buộc đổi mật khẩu ở lần đăng nhập kế (tài khoản do admin tạo). */
    mustChangePassword: boolean('must_change_password').notNull().default(false),

    /**
     * Khoá tài khoản sau nhiều lần sai mật khẩu.
     *
     * Không có cái này thì bcrypt salt 10 cũng không cứu được: kẻ tấn công thử
     * online với tốc độ mạng, không phải tốc độ băm.
     */
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),

    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqUsername: unique('uq_users_username').on(t.username),
    chkFailed: check('chk_users_failed', sql`${t.failedAttempts} >= 0`),
  }),
);

export const roles = pgTable('roles', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 60 }).notNull().unique(),
  nameVi: varchar('name_vi', { length: 120 }).notNull(),
  description: text('description'),
  /**
   * Vai trò hệ thống không xoá được. ADMIN mà xoá được thì một lần bấm nhầm
   * sẽ khoá mọi người ở ngoài, kể cả chính mình.
   */
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Quyền theo dạng `vùng:hành động` — vd `payroll:run`, `policy:activate`.
 *
 * Dạng phẳng có chủ ý. Cây quyền phân cấp nghe sang nhưng sinh ra những câu
 * hỏi không có đáp án rõ ràng ("policy:read có kéo theo payroll:read không?"),
 * và mỗi lần thêm một quyền mới lại phải nghĩ lại cả cây.
 */
export const permissions = pgTable('permissions', {
  id: uuid('id').primaryKey().defaultRandom(),
  code: varchar('code', { length: 80 }).notNull().unique(),
  nameVi: varchar('name_vi', { length: 160 }).notNull(),
  description: text('description'),
});

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionId: uuid('permission_id')
      .notNull()
      .references(() => permissions.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: unique('pk_role_permissions').on(t.roleId, t.permissionId),
  }),
);

/**
 * Phạm vi dữ liệu — tầng RBAC thứ hai.
 *
 * QUYỀN trả lời "được làm gì", PHẠM VI trả lời "trên dữ liệu của ai". Hai câu
 * hỏi độc lập: một trưởng phòng có `payroll:read` nhưng chỉ trên phòng mình.
 * Gộp hai thứ vào một bảng quyền sẽ sinh ra tổ hợp nổ (mỗi quyền × mỗi phòng).
 */
export const DATA_SCOPE_LEVELS = ['COMPANY', 'BRANCH', 'DEPARTMENT', 'SELF'] as const;
export type DataScopeLevel = (typeof DATA_SCOPE_LEVELS)[number];

export const userRoles = pgTable(
  'user_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: uuid('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),

    scopeLevel: varchar('scope_level', { length: 20 }).notNull().default('SELF'),
    /** Giá trị của phạm vi: mã chi nhánh, tên phòng… NULL với COMPANY/SELF. */
    scopeValue: varchar('scope_value', { length: 120 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqUserRoleScope: unique('uq_user_roles_user_role_scope').on(
      t.userId,
      t.roleId,
      t.scopeValue,
    ),
    idxUser: index('idx_user_roles_user').on(t.userId),
    chkScopeLevel: check(
      'chk_user_roles_scope_level',
      sql`${t.scopeLevel} IN ('COMPANY','BRANCH','DEPARTMENT','SELF')`,
    ),
  }),
);

/**
 * Refresh token.
 *
 * LƯU HASH, KHÔNG LƯU TOKEN. Rò rỉ bảng này thì kẻ tấn công vẫn không đăng
 * nhập được — đúng lý do ta băm mật khẩu.
 *
 * `replacedBy` + `revokedAt` cho phép phát hiện TÁI SỬ DỤNG: mỗi lần refresh
 * sinh token mới và thu hồi token cũ. Nếu một token đã thu hồi được trình ra
 * lần nữa thì nghĩa là token đã bị lộ (hoặc bị đánh cắp) — thu hồi cả họ.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** SHA-256 của token. Khoá chính để tra cứu. */
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    /** Họ token — mọi token sinh ra từ cùng một lần đăng nhập. */
    familyId: uuid('family_id').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    replacedBy: uuid('replaced_by'),

    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uqTokenHash: unique('uq_refresh_tokens_hash').on(t.tokenHash),
    idxUser: index('idx_refresh_tokens_user').on(t.userId),
    idxFamily: index('idx_refresh_tokens_family').on(t.familyId),
  }),
);

/**
 * Giới hạn tốc độ — lưu trong DATABASE, không phải trong bộ nhớ.
 *
 * In-memory rate limiter reset mỗi lần restart và không dùng được khi chạy
 * nhiều tiến trình: kẻ tấn công chỉ cần làm restart, hoặc gửi request tới
 * tiến trình khác. Với một cơ chế an ninh thì "reset khi restart" là một lỗ.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Khoá của bucket: 'login:10.0.0.5', 'api:user-123'… */
    bucketKey: varchar('bucket_key', { length: 160 }).notNull(),
    windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
    count: integer('count').notNull().default(0),
  },
  (t) => ({
    uqBucketWindow: unique('uq_rate_limit_bucket_window').on(t.bucketKey, t.windowStart),
  }),
);
