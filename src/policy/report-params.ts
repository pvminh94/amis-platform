/**
 * ============================================================================
 * ĐỊNH NGHĨA BÁO CÁO (REPORT_DEF) — loại chính sách thứ sáu
 * ============================================================================
 *
 * Người dùng SOẠN báo cáo bằng cách chọn nguồn, cột, phép gộp, điều kiện.
 * Kết quả là JSON, lưu trong database, sửa được trên giao diện.
 *
 * RANH GIỚI AN TOÀN — và đây là toàn bộ thiết kế:
 *
 *   Một định nghĩa báo cáo KHÔNG BAO GIỜ chứa SQL.
 *
 * Người dùng chỉ được chọn từ `SOURCES` — một danh sách nguồn cố định, mỗi
 * nguồn có một tập cột whitelist. Engine ghép SQL từ những mảnh đã được viết
 * sẵn và kiểm soát; giá trị luôn đi qua tham số ($1, $2…). Không có đường nào
 * để một chuỗi do người dùng nhập lọt vào câu SQL dưới dạng mã.
 *
 * Vì sao không cho nhập SQL trực tiếp? Vì ERP cho phép nhập SQL nghĩa là bất
 * kỳ ai có quyền soạn báo cáo đều có quyền `DROP TABLE`. Có những thứ đáng
 * tiện lợi đến đâu cũng không đáng đổi bằng khả năng đó.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// NGUỒN DỮ LIỆU — whitelist duy nhất
// ---------------------------------------------------------------------------

export const COLUMN_TYPES = ['text', 'money', 'number', 'percent', 'bool'] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

export interface SourceColumn {
  label: string;
  type: ColumnType;
  /** Tên cột THẬT trong câu FROM của nguồn. Do tôi viết, không phải người dùng. */
  column: string;
}

export interface ReportSource {
  label: string;
  /** Câu FROM + JOIN, viết sẵn. Người dùng không chạm tới được. */
  from: string;
  columns: Record<string, SourceColumn>;
}

export const SOURCES: Record<string, ReportSource> = {
  PAYSLIPS: {
    label: 'Phiếu lương',
    from: `FROM payslips ps
           JOIN employees e ON e.id = ps.employee_id
           JOIN pay_runs pr ON pr.id = ps.pay_run_id`,
    columns: {
      period: { label: 'Kỳ lương', type: 'text', column: `pr.period_year || '-' || lpad(pr.period_month::text, 2, '0')` },
      period_year: { label: 'Năm', type: 'number', column: 'pr.period_year' },
      period_month: { label: 'Tháng', type: 'number', column: 'pr.period_month' },
      employee_code: { label: 'Mã nhân viên', type: 'text', column: 'ps.employee_code' },
      full_name: { label: 'Họ tên', type: 'text', column: 'ps.full_name' },
      department: { label: 'Bộ phận', type: 'text', column: 'e.department' },
      wage_region: { label: 'Vùng lương', type: 'text', column: 'e.wage_region' },
      trained_worker: { label: 'Đã qua đào tạo', type: 'bool', column: 'e.trained_worker' },
      worked_days: { label: 'Ngày công', type: 'number', column: `(ps.variables->>'workedDays')::numeric` },
      earnings_total: { label: 'Tổng thu nhập', type: 'money', column: 'ps.earnings_total' },
      deductions_total: { label: 'Tổng khấu trừ', type: 'money', column: 'ps.deductions_total' },
      taxable_income: { label: 'Thu nhập chịu thuế', type: 'money', column: 'ps.taxable_income' },
      insurance_base: { label: 'Lương đóng BH', type: 'money', column: 'ps.insurance_base' },
      si_base: { label: 'Căn cứ BHXH', type: 'money', column: 'ps.si_base' },
      ui_base: { label: 'Căn cứ BHTN', type: 'money', column: 'ps.ui_base' },
      si_employee: { label: 'BH người lao động', type: 'money', column: 'ps.si_employee' },
      si_employer: { label: 'BH doanh nghiệp', type: 'money', column: 'ps.si_employer' },
      pit: { label: 'Thuế TNCN', type: 'money', column: 'ps.pit' },
      net_pay: { label: 'Thực nhận', type: 'money', column: 'ps.net_pay' },
    },
  },
  EMPLOYEES: {
    label: 'Nhân viên',
    from: 'FROM employees emp',
    columns: {
      employee_code: { label: 'Mã nhân viên', type: 'text', column: 'emp.employee_code' },
      full_name: { label: 'Họ tên', type: 'text', column: 'emp.full_name' },
      department: { label: 'Bộ phận', type: 'text', column: 'emp.department' },
      wage_region: { label: 'Vùng lương', type: 'text', column: 'emp.wage_region' },
      trained_worker: { label: 'Đã qua đào tạo', type: 'bool', column: 'emp.trained_worker' },
      dependents: { label: 'Người phụ thuộc', type: 'number', column: 'emp.dependents' },
      base_salary: { label: 'Lương cơ bản', type: 'money', column: 'emp.base_salary' },
      hourly_rate: { label: 'Lương giờ', type: 'money', column: 'emp.hourly_rate' },
      active: { label: 'Đang làm việc', type: 'bool', column: 'emp.active' },
    },
  },
};

// ---------------------------------------------------------------------------
// PHÉP GỘP VÀ PHÉP SO SÁNH — cũng là whitelist
// ---------------------------------------------------------------------------

export const AGGREGATIONS = ['sum', 'count', 'avg', 'min', 'max'] as const;
export type Aggregation = (typeof AGGREGATIONS)[number];

export const FILTER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'like', 'in'] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

/**
 * Phép gộp hợp lệ theo kiểu cột.
 *
 * `sum` trên một cột text không phải lỗi cú pháp ở mọi hệ CSDL — PostgreSQL sẽ
 * báo lỗi, nhưng SQLite hay MySQL có thể lặng lẽ cho ra kết quả vô nghĩa.
 * Chặn ngay lúc lưu thì người soạn biết ngay mình chọn sai.
 */
const NUMERIC_AGGREGATIONS: Aggregation[] = ['sum', 'avg', 'min', 'max'];
export function isNumericColumn(type: ColumnType): boolean {
  return type === 'money' || type === 'number' || type === 'percent';
}
export function aggregationAllowed(agg: Aggregation, type: ColumnType): boolean {
  if (agg === 'count') return true;
  return isNumericColumn(type) && NUMERIC_AGGREGATIONS.includes(agg);
}

/** Phép so sánh hợp lệ theo kiểu cột — `like` chỉ dành cho text. */
export function filterOpAllowed(op: FilterOp, type: ColumnType): boolean {
  if (op === 'like') return type === 'text';
  if (op === 'in') return type !== 'bool';
  return true;
}

// ---------------------------------------------------------------------------
// SCHEMA
// ---------------------------------------------------------------------------

/**
 * Mã cột phải ASCII. Không phải vì ghét tiếng Việt — mà vì mã này thành
 * ALIAS trong câu SQL và THÀNH KHOÁ trong JSON kết quả. `BH_NSDLĐ` chạy được
 * trên PostgreSQL nhưng vỡ ngay khi xuất sang Excel/CSV hay một hệ khác.
 *
 * Thông báo lỗi phải nói rõ điều đó: người dùng Việt sẽ gõ 'Đ' theo phản xạ,
 * và một chữ "Invalid" không giúp họ hiểu vì sao.
 */
const CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;
const CODE_MESSAGE =
  'Mã cột chỉ dùng chữ IN HOA không dấu (A-Z), số và gạch dưới. ' +
  "Ví dụ 'BH_NSDLD' chứ không phải 'BH_NSDLĐ' — mã này thành alias SQL và khoá JSON.";

export const reportDimensionSchema = z.object({
  code: z.string().regex(CODE_REGEX, CODE_MESSAGE).describe('Mã cột trong kết quả'),
  label: z.string().min(1),
  /** Phải là một khoá trong SOURCES[source].columns. */
  field: z.string().min(1),
});
export type ReportDimension = z.infer<typeof reportDimensionSchema>;

export const reportMeasureSchema = z.object({
  code: z.string().regex(CODE_REGEX, CODE_MESSAGE),
  label: z.string().min(1),
  field: z.string().min(1),
  aggregation: z.enum(AGGREGATIONS),
});
export type ReportMeasure = z.infer<typeof reportMeasureSchema>;

export const reportFilterSchema = z.object({
  field: z.string().min(1),
  op: z.enum(FILTER_OPS),
  /** Chuỗi; engine ép kiểu theo cột. `in` nhận danh sách phân cách bằng dấu phẩy. */
  value: z.string(),
  /** Trường có thể là dimension (sau khi gộp) thay vì cột thô. */
  onResult: z.boolean(),
});
export type ReportFilter = z.infer<typeof reportFilterSchema>;

export const reportOrderBySchema = z.object({
  field: z.string().min(1),
  direction: z.enum(['asc', 'desc']),
});
export type ReportOrderBy = z.infer<typeof reportOrderBySchema>;

export const reportParamsSchema = z
  .object({
    regimeCode: z
      .string()
      .regex(CODE_REGEX, CODE_MESSAGE)
      .describe('Mã báo cáo, ví dụ LUONG_THEO_BO_PHAN'),
    regimeLabel: z.string().min(1).describe('Tên hiển thị'),
    description: z.string().describe('Mô tả ngắn cho người dùng'),
    source: z.string().min(1).describe('Khoá trong SOURCES'),
    dimensions: z.array(reportDimensionSchema),
    measures: z.array(reportMeasureSchema),
    filters: z.array(reportFilterSchema),
    orderBy: z.array(reportOrderBySchema),
    /**
     * Có giới hạn trên. Một báo cáo không giới hạn trên bảng triệu dòng sẽ treo
     * cả server, và đó là lỗi người dùng có thể gây ra chỉ bằng cách bấm lưu.
     */
    limit: z.number().int().min(1).max(10_000),
    /** Định dạng tiền tệ mặc định khi xuất. */
    currency: z.string().min(1),
  })
  .superRefine((p, ctx) => {
    const source = SOURCES[p.source];
    if (!source) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['source'],
        message: `Nguồn '${p.source}' không tồn tại. Có: ${Object.keys(SOURCES).join(', ')}.`,
      });
      // Không có nguồn thì mọi kiểm tra cột phía sau đều vô nghĩa.
      return;
    }

    const col = (field: string, path: (string | number)[]) => {
      const c = source.columns[field];
      if (!c) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `Cột '${field}' không có trong nguồn '${p.source}'.`,
        });
        return undefined;
      }
      return c;
    };

    // --- Mã cột kết quả không được trùng --------------------------------
    const codes = new Set<string>();
    for (const [i, d] of p.dimensions.entries()) {
      if (codes.has(d.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['dimensions', i, 'code'],
          message: `Mã '${d.code}' đã được dùng. Hai cột trùng mã thì cột sau ghi đè cột trước trong kết quả.`,
        });
      }
      codes.add(d.code);
      col(d.field, ['dimensions', i, 'field']);
    }
    for (const [i, m] of p.measures.entries()) {
      if (codes.has(m.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['measures', i, 'code'],
          message: `Mã '${m.code}' trùng với một cột khác.`,
        });
      }
      codes.add(m.code);
      const c = col(m.field, ['measures', i, 'field']);
      if (c && !aggregationAllowed(m.aggregation, c.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['measures', i, 'aggregation'],
          message: `Không thể ${m.aggregation}() trên cột kiểu '${c.type}'.`,
        });
      }
    }

    // --- Phải có gì đó để hiển thị ---------------------------------------
    if (p.dimensions.length === 0 && p.measures.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['measures'],
        message: 'Báo cáo cần ít nhất một cột nhóm hoặc một chỉ tiêu.',
      });
    }

    // --- Điều kiện lọc ----------------------------------------------------
    const dimensionCodes = new Set(p.dimensions.map((d) => d.code));
    for (const [i, f] of p.filters.entries()) {
      if (f.onResult) {
        if (!dimensionCodes.has(f.field) && !codes.has(f.field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['filters', i, 'field'],
            message: `'${f.field}' không phải là một cột trong kết quả.`,
          });
        }
        continue;
      }
      const c = col(f.field, ['filters', i, 'field']);
      if (c && !filterOpAllowed(f.op, c.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['filters', i, 'op'],
          message: `Phép '${f.op}' không áp dụng cho cột kiểu '${c.type}'.`,
        });
      }
    }

    // --- Sắp xếp ----------------------------------------------------------
    for (const [i, o] of p.orderBy.entries()) {
      const c = source.columns[o.field];
      if (!c && !codes.has(o.field)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['orderBy', i, 'field'],
          message: `'${o.field}' không phải cột của nguồn '${p.source}' cũng không phải cột kết quả.`,
        });
      }
    }
  });

export type ReportParams = z.infer<typeof reportParamsSchema>;

// ---------------------------------------------------------------------------
// JSON SCHEMA — nguồn duy nhất để giao diện tự sinh form
// ---------------------------------------------------------------------------

export const reportJsonSchema = {
  type: 'object',
  required: [
    'regimeCode',
    'regimeLabel',
    'description',
    'source',
    'dimensions',
    'measures',
    'filters',
    'orderBy',
    'limit',
    'currency',
  ],
  properties: {
    regimeCode: {
      type: 'string',
      title: 'Mã báo cáo',
      pattern: '^[A-Z][A-Z0-9_]*$',
      description: 'Ví dụ LUONG_THEO_BO_PHAN',
    },
    regimeLabel: { type: 'string', title: 'Tên báo cáo' },
    description: { type: 'string', title: 'Mô tả', format: 'textarea' },
    source: {
      type: 'string',
      title: 'Nguồn dữ liệu',
      enum: Object.keys(SOURCES),
      enumLabels: Object.fromEntries(
        Object.entries(SOURCES).map(([k, v]) => [k, v.label]),
      ),
    },
    dimensions: {
      type: 'array',
      title: 'Cột nhóm (GROUP BY)',
      items: {
        type: 'object',
        required: ['code', 'label', 'field'],
        properties: {
          code: { type: 'string', title: 'Mã cột', pattern: '^[A-Z][A-Z0-9_]*$' },
          label: { type: 'string', title: 'Tiêu đề' },
          field: { type: 'string', title: 'Trường nguồn' },
        },
      },
    },
    measures: {
      type: 'array',
      title: 'Chỉ tiêu (đo lường)',
      items: {
        type: 'object',
        required: ['code', 'label', 'field', 'aggregation'],
        properties: {
          code: { type: 'string', title: 'Mã cột', pattern: '^[A-Z][A-Z0-9_]*$' },
          label: { type: 'string', title: 'Tiêu đề' },
          field: { type: 'string', title: 'Trường nguồn' },
          aggregation: {
            type: 'string',
            title: 'Phép gộp',
            enum: [...AGGREGATIONS],
          },
        },
      },
    },
    filters: {
      type: 'array',
      title: 'Điều kiện lọc',
      items: {
        type: 'object',
        required: ['field', 'op', 'value', 'onResult'],
        properties: {
          field: { type: 'string', title: 'Trường' },
          op: { type: 'string', title: 'Phép so sánh', enum: [...FILTER_OPS] },
          value: {
            type: 'string',
            title: 'Giá trị',
            description: 'Với phép "in", phân cách bằng dấu phẩy',
          },
          onResult: {
            type: 'boolean',
            title: 'Lọc trên kết quả (HAVING)',
          },
        },
      },
    },
    orderBy: {
      type: 'array',
      title: 'Sắp xếp',
      items: {
        type: 'object',
        required: ['field', 'direction'],
        properties: {
          field: { type: 'string', title: 'Trường' },
          direction: { type: 'string', title: 'Chiều', enum: ['asc', 'desc'] },
        },
      },
    },
    limit: {
      type: 'number',
      title: 'Giới hạn số dòng',
      minimum: 1,
      maximum: 10000,
      description: 'Chặn một báo cáo không giới hạn treo cả server',
    },
    currency: { type: 'string', title: 'Đơn vị tiền tệ', description: 'Ví dụ: đ' },
  },
} as const;

// ---------------------------------------------------------------------------
// SEED
// ---------------------------------------------------------------------------

export const SEED_REPORT_PAYROLL_BY_DEPT: ReportParams = {
  regimeCode: 'LUONG_THEO_BO_PHAN',
  regimeLabel: 'Tổng hợp lương theo bộ phận',
  description:
    'Gộp toàn bộ phiếu lương theo bộ phận: tổng thu nhập, bảo hiểm hai phía, thuế và thực nhận. Dùng cho báo cáo chi phí nhân sự hàng tháng.',
  source: 'PAYSLIPS',
  dimensions: [
    { code: 'BO_PHAN', label: 'Bộ phận', field: 'department' },
    { code: 'KY', label: 'Kỳ lương', field: 'period' },
  ],
  measures: [
    { code: 'SO_NGUOI', label: 'Số người', field: 'employee_code', aggregation: 'count' },
    { code: 'TONG_THU_NHAP', label: 'Tổng thu nhập', field: 'earnings_total', aggregation: 'sum' },
    { code: 'BH_NLD', label: 'BH người lao động', field: 'si_employee', aggregation: 'sum' },
    { code: 'BH_NSDLD', label: 'BH doanh nghiệp', field: 'si_employer', aggregation: 'sum' },
    { code: 'THUE', label: 'Thuế TNCN', field: 'pit', aggregation: 'sum' },
    { code: 'THUC_NHAN', label: 'Thực nhận', field: 'net_pay', aggregation: 'sum' },
  ],
  filters: [],
  orderBy: [
    { field: 'BO_PHAN', direction: 'asc' },
    { field: 'KY', direction: 'desc' },
  ],
  limit: 500,
  currency: 'đ',
};

export const SEED_REPORT_PAYROLL_TOP: ReportParams = {
  regimeCode: 'LUONG_CA_NHAN_TOP',
  regimeLabel: 'Nhân viên có thực nhận cao nhất',
  description:
    'Xếp hạng từng nhân viên theo thực nhận trong một kỳ. Lọc HAVING để loại những phiếu có thực nhận bằng 0.',
  source: 'PAYSLIPS',
  dimensions: [
    { code: 'MA_NV', label: 'Mã', field: 'employee_code' },
    { code: 'HO_TEN', label: 'Họ tên', field: 'full_name' },
    { code: 'BO_PHAN', label: 'Bộ phận', field: 'department' },
    { code: 'VUNG', label: 'Vùng', field: 'wage_region' },
  ],
  measures: [
    { code: 'THU_NHAP', label: 'Thu nhập', field: 'earnings_total', aggregation: 'sum' },
    { code: 'THUC_NHAN', label: 'Thực nhận', field: 'net_pay', aggregation: 'sum' },
  ],
  filters: [
    { field: 'THUC_NHAN', op: 'gt', value: '0', onResult: true },
  ],
  orderBy: [{ field: 'THUC_NHAN', direction: 'desc' }],
  limit: 50,
  currency: 'đ',
};
