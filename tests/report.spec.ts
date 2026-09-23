/**
 * Test engine báo cáo.
 *
 * Trọng tâm là RANH GIỚI AN TOÀN: một định nghĩa báo cáo không bao giờ được
 * để một chuỗi do người dùng nhập lọt vào SQL dưới dạng mã.
 */

import { describe, it, expect } from 'vitest';
import { buildReportQuery, runReport, toCsv } from '../src/engine/report';
import {
  SEED_REPORT_PAYROLL_BY_DEPT,
  SEED_REPORT_PAYROLL_TOP,
  reportParamsSchema,
  SOURCES,
  aggregationAllowed,
  filterOpAllowed,
  type ReportParams,
} from '../src/policy/report-params';

const base = (): ReportParams =>
  JSON.parse(JSON.stringify(SEED_REPORT_PAYROLL_BY_DEPT)) as ReportParams;

describe('seed báo cáo phải hợp lệ theo chính schema của nó', () => {
  it.each([
    ['LUONG_THEO_BO_PHAN', SEED_REPORT_PAYROLL_BY_DEPT],
    ['LUONG_CA_NHAN_TOP', SEED_REPORT_PAYROLL_TOP],
  ])('%s parse sạch', (_name, def) => {
    const parsed = reportParamsSchema.safeParse(def);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues, null, 2));
    expect(parsed.success).toBe(true);
  });
});

describe('buildReportQuery — cấu trúc câu SQL', () => {
  it('ghép SELECT/GROUP BY/ORDER BY/LIMIT đúng thứ tự', () => {
    const q = buildReportQuery(SEED_REPORT_PAYROLL_BY_DEPT);
    const lines = q.sql.split('\n');
    expect(lines[0]).toMatch(/^SELECT /);
    expect(q.sql).toContain('GROUP BY');
    expect(q.sql).toContain('ORDER BY');
    expect(q.sql).toMatch(/LIMIT \$\d+$/);
  });

  it('LIMIT là THAM SỐ chứ không phải số nối thẳng vào SQL', () => {
    const q = buildReportQuery(base());
    expect(q.sql).toMatch(/LIMIT \$\d+$/);
    expect(q.values).toContain(500);
    // Và SQL không chứa con số 500 trần ở đâu cả.
    expect(q.sql).not.toContain('500');
  });

  it('mỗi chiều ra một cột GROUP BY, mỗi chỉ tiêu ra một phép gộp', () => {
    const q = buildReportQuery(SEED_REPORT_PAYROLL_BY_DEPT);
    expect(q.columns.filter((c) => !c.isMeasure)).toHaveLength(2);
    expect(q.columns.filter((c) => c.isMeasure)).toHaveLength(6);
    // Alias bọc nháy kép: không bọc thì PostgreSQL hạ xuống chữ thường và
    // người dùng chọn mã 'THỰC NHẬN' sẽ nhận về khoá không đoán được.
    expect(q.sql).toContain('count(ps.employee_code) AS "SO_NGUOI"');
    expect(q.sql).toContain('sum(ps.net_pay) AS "THUC_NHAN"');
  });

  it('count() trên cột text được phép, sum() thì không', () => {
    expect(aggregationAllowed('count', 'text')).toBe(true);
    expect(aggregationAllowed('sum', 'text')).toBe(false);
  });

  it('sum/avg chỉ dành cho cột số', () => {
    expect(aggregationAllowed('sum', 'money')).toBe(true);
    expect(aggregationAllowed('avg', 'number')).toBe(true);
    expect(aggregationAllowed('sum', 'bool')).toBe(false);
    expect(aggregationAllowed('avg', 'text')).toBe(false);
  });

  it('like chỉ dành cho text', () => {
    expect(filterOpAllowed('like', 'text')).toBe(true);
    expect(filterOpAllowed('like', 'money')).toBe(false);
  });
});

describe('HAVING phải dùng biểu thức gộp, không dùng alias', () => {
  it('PostgreSQL không cho tham chiếu alias của SELECT trong HAVING', () => {
    // Lỗi thật đã gặp: `HAVING THUC_NHAN > $1` nổ với
    // "column thuc_nhan does not exist" dù THUC_NHAN có trong SELECT.
    const q = buildReportQuery(SEED_REPORT_PAYROLL_TOP);
    expect(q.sql).toContain('HAVING sum(ps.net_pay) > $1');
    expect(q.sql).not.toMatch(/HAVING "?THUC_NHAN"?\s*>/);
  });

  it('ORDER BY thì được dùng alias — nhưng cũng phải bọc nháy', () => {
    const q = buildReportQuery(SEED_REPORT_PAYROLL_TOP);
    expect(q.sql).toContain('ORDER BY "THUC_NHAN" DESC');
  });
});

describe('RANH GIỚI AN TOÀN — tiêm SQL', () => {
  it('giá trị lọc độc hại chỉ là một tham số, không phải mã', () => {
    const def = base();
    def.filters = [
      { field: 'department', op: 'eq', value: `x'); DROP TABLE employees; --`, onResult: false },
    ];
    const q = buildReportQuery(def);
    // Chuỗi độc hại NẰM TRONG values, không nằm trong SQL.
    expect(q.sql).not.toContain('DROP TABLE');
    expect(q.sql).toContain('WHERE e.department = $1');
    expect(q.values[0]).toBe(`x'); DROP TABLE employees; --`);
  });

  it('phép like bọc % nhưng vẫn truyền giá trị qua tham số', () => {
    const def = base();
    def.filters = [{ field: 'department', op: 'like', value: `kỹ'; --`, onResult: false }];
    const q = buildReportQuery(def);
    expect(q.sql).toContain('LIKE $1');
    expect(q.values[0]).toBe(`%kỹ'; --%`);
    expect(q.sql).not.toContain('kỹ');
  });

  it('phép in tách danh sách thành nhiều tham số', () => {
    const def = base();
    def.filters = [{ field: 'wage_region', op: 'in', value: 'I, II,IV', onResult: false }];
    const q = buildReportQuery(def);
    expect(q.sql).toContain('IN ($1, $2, $3)');
    expect(q.values.slice(0, 3)).toEqual(['I', 'II', 'IV']);
  });

  it('in rỗng bị chặn thay vì sinh ra `IN ()` làm hỏng câu SQL', () => {
    const def = base();
    def.filters = [{ field: 'wage_region', op: 'in', value: '  , ,', onResult: false }];
    expect(() => buildReportQuery(def)).toThrow(/không có giá trị nào/);
  });

  it('tên cột không có trong whitelist bị chặn ở ENGINE, không chỉ ở schema', () => {
    // Định nghĩa này được ghi thẳng vào database, bỏ qua API — schema không chạy.
    const def = base();
    def.dimensions = [{ code: 'X', label: 'x', field: 'net_pay; DROP TABLE payslips' }];
    expect(() => buildReportQuery(def)).toThrow(/không có trong nguồn/);
  });

  it('nguồn không tồn tại bị chặn', () => {
    const def = base();
    def.source = 'KHONG_CO';
    expect(() => buildReportQuery(def)).toThrow(/không tồn tại/);
  });

  it('mọi cột của mọi nguồn đều là tên hợp lệ, không có chỗ để chèn mã', () => {
    // Chốt chặn cuối: ngay cả danh sách whitelist cũng phải sạch.
    for (const [name, src] of Object.entries(SOURCES)) {
      for (const [field, c] of Object.entries(src.columns)) {
        expect(c.column, `${name}.${field}`).not.toMatch(/;|--|\/\*/);
      }
    }
  });
});

describe('schema chặn định nghĩa sai ngay lúc lưu', () => {
  it('cột không tồn tại', () => {
    const def = base();
    def.dimensions = [{ code: 'X', label: 'x', field: 'khong_co_cot_nay' }];
    const r = reportParamsSchema.safeParse(def);
    expect(r.success).toBe(false);
  });

  it('sum() trên cột text', () => {
    const def = base();
    def.measures = [{ code: 'X', label: 'x', field: 'department', aggregation: 'sum' }];
    const r = reportParamsSchema.safeParse(def);
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(JSON.stringify(r.error.issues)).toMatch(/Không thể sum/);
    }
  });

  it('hai cột trùng mã — cột sau sẽ ghi đè cột trước trong kết quả', () => {
    const def = base();
    def.dimensions = [
      { code: 'TRUNG', label: 'a', field: 'department' },
      { code: 'TRUNG', label: 'b', field: 'wage_region' },
    ];
    const r = reportParamsSchema.safeParse(def);
    expect(r.success).toBe(false);
  });

  it('không có cột nào để hiển thị', () => {
    const def = base();
    def.dimensions = [];
    def.measures = [];
    expect(reportParamsSchema.safeParse(def).success).toBe(false);
  });

  it('nguồn không tồn tại', () => {
    const def = base();
    def.source = 'KHONG_CO';
    expect(reportParamsSchema.safeParse(def).success).toBe(false);
  });

  it('HAVING tham chiếu cột không có trong kết quả', () => {
    const def = base();
    def.filters = [{ field: 'KHONG_CO', op: 'gt', value: '0', onResult: true }];
    expect(reportParamsSchema.safeParse(def).success).toBe(false);
  });

  it('like trên cột tiền', () => {
    const def = base();
    def.filters = [{ field: 'net_pay', op: 'like', value: '1', onResult: false }];
    expect(reportParamsSchema.safeParse(def).success).toBe(false);
  });

  it('giới hạn 10.000 dòng — chặn báo cáo không giới hạn treo server', () => {
    const def = base();
    def.limit = 1_000_000;
    expect(reportParamsSchema.safeParse(def).success).toBe(false);
  });
});

describe('ép kiểu giá trị lọc', () => {
  it('chấp nhận dấu chấm phân cách phần nghìn theo thói quen Việt', () => {
    const def = base();
    def.filters = [{ field: 'net_pay', op: 'gt', value: '49.670.000', onResult: false }];
    const q = buildReportQuery(def);
    expect(q.values[0]).toBe(49670000);
  });

  it('chuỗi không phải số thì báo lỗi, không âm thầm thành NaN', () => {
    // NaN vào query sẽ cho ra kết quả rỗng mà không có lỗi nào — người dùng
    // sẽ tưởng là "không có dữ liệu".
    const def = base();
    def.filters = [{ field: 'net_pay', op: 'gt', value: 'nhiều', onResult: false }];
    expect(() => buildReportQuery(def)).toThrow(/không phải là số/);
  });

  it('bool chấp nhận cả chữ tiếng Việt', () => {
    const def = base();
    def.filters = [{ field: 'trained_worker', op: 'eq', value: 'có', onResult: false }];
    expect(buildReportQuery(def).values[0]).toBe(true);
    def.filters = [{ field: 'trained_worker', op: 'eq', value: 'không', onResult: false }];
    expect(buildReportQuery(def).values[0]).toBe(false);
  });
});

describe('runReport — engine không tự biết database nằm ở đâu', () => {
  it('giao SQL và tham số cho executor được tiêm vào', async () => {
    const seen: Array<{ sql: string; values: unknown[] }> = [];
    const res = await runReport(SEED_REPORT_PAYROLL_BY_DEPT, async (sql, values) => {
      seen.push({ sql, values });
      return [{ BO_PHAN: 'Kỹ thuật', THUC_NHAN: 100 }];
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toBe(res.sql);
    expect(seen[0]!.values).toEqual(res.values);
    expect(res.rows).toHaveLength(1);
    expect(typeof res.durationMs).toBe('number');
  });
});

describe('toCsv — escape đúng RFC 4180', () => {
  const columns = [
    { code: 'A', label: 'Bộ phận', type: 'text' as const, isMeasure: false },
    { code: 'B', label: 'Tiền', type: 'money' as const, isMeasure: true },
  ];

  it('dấu phẩy và nháy kép trong dữ liệu không phá vỡ cấu trúc', () => {
    const csv = toCsv(
      columns,
      [{ A: 'Kỹ thuật, ca 2', B: 1000 }, { A: 'Nói "không"', B: 2000 }],
      'đ',
    );
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Bộ phận,Tiền');
    // Mỗi dòng vẫn đúng 2 cột khi tách theo CSV.
    expect(lines[1]).toBe('"Kỹ thuật, ca 2",1000 đ');
    expect(lines[2]).toBe('"Nói ""không""",2000 đ');
  });

  it('null và undefined thành ô rỗng, không thành chữ "null"', () => {
    const csv = toCsv(columns, [{ A: null, B: undefined }]);
    expect(csv.split('\n')[1]).toBe(',');
  });

  it('đọc được tên cột viết thường do PostgreSQL trả về', () => {
    // Mã cột của ta viết HOA, nhưng driver trả khoá viết thường.
    const csv = toCsv(columns, [{ a: 'X', b: 5 }]);
    expect(csv.split('\n')[1]).toBe('X,5');
  });
});
