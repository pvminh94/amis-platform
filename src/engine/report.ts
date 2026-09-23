/**
 * ============================================================================
 * ENGINE BÁO CÁO — ghép SQL từ một định nghĩa JSON
 * ============================================================================
 *
 * QUY TẮC DUY NHẤT, và mọi thứ khác suy ra từ nó:
 *
 *   Chỉ có TÊN CỘT và TÊN PHÉP TOÁN được ghép vào chuỗi SQL, và cả hai đều
 *   đến từ whitelist trong `SOURCES`/`AGGREGATIONS`/`FILTER_OPS`.
 *   Mọi GIÁ TRỊ đi qua tham số `$1, $2, …` của driver.
 *
 * Nghĩa là một người dùng nhập giá trị lọc là `'); DROP TABLE employees; --`
 * thì chuỗi đó chỉ là một chuỗi tham số vô hại. Còn nếu họ nhập một tên cột
 * không có trong whitelist thì schema đã chặn từ lúc lưu, và engine kiểm tra
 * lại một lần nữa ở đây.
 *
 * Kiểm tra hai lần không phải thừa: schema chạy lúc LƯU, engine chạy lúc ĐỌC.
 * Một định nghĩa có thể được ghi thẳng vào database bằng SQL, bỏ qua API.
 * Đừng tin dữ liệu chỉ vì mình từng kiểm tra nó.
 */

import { SOURCES, type ReportParams, type ColumnType } from '@/policy/report-params';

export interface ReportColumn {
  code: string;
  label: string;
  type: ColumnType;
  /** true nếu đây là chỉ tiêu đã gộp (định dạng tiền tệ khi xuất). */
  isMeasure: boolean;
}

export interface ReportQuery {
  sql: string;
  values: unknown[];
  columns: ReportColumn[];
}

export interface ReportResult extends ReportQuery {
  rows: Record<string, unknown>[];
  /** Tổng thời gian chạy query, mili giây. */
  durationMs: number;
}

/** Ép một chuỗi nhập từ người dùng sang đúng kiểu của cột. */
function coerce(value: string, type: ColumnType, what: string): unknown {
  switch (type) {
    case 'money':
    case 'number':
    case 'percent': {
      // Chấp nhận dấu phẩy làm phân cách phần nghìn — người dùng Việt nhập
      // "49.670.000" theo thói quen đọc số.
      const n = Number(value.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(n)) {
        throw new RangeError(`${what}: '${value}' không phải là số.`);
      }
      return n;
    }
    case 'bool': {
      const v = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'có', 'dung', 'đúng'].includes(v)) return true;
      if (['false', '0', 'no', 'không', 'sai'].includes(v)) return false;
      throw new RangeError(`${what}: '${value}' không phải true/false.`);
    }
    default:
      return value;
  }
}

/**
 * Ghép câu SQL. Thuần tuý, không chạm database — nên test được toàn bộ mà
 * không cần PostgreSQL chạy.
 */
export function buildReportQuery(def: ReportParams): ReportQuery {
  const source = SOURCES[def.source];
  if (!source) {
    throw new RangeError(
      `Nguồn '${def.source}' không tồn tại. Có: ${Object.keys(SOURCES).join(', ')}.`,
    );
  }

  const values: unknown[] = [];
  /**
   * Thêm một giá trị và trả về chỗ giữ chỗ của CHÍNH NÓ.
   *
   * Phải gộp "push" và "lấy số" vào MỘT hàm. Bản đầu tiên tách làm hai bước
   * (`values.push(x)` rồi `$${values.length + 1}`) nên mỗi chỗ giữ chỗ đều lệch
   * lên một: LIMIT trùng số với tham số cuối của một điều kiện IN, và câu SQL
   * chạy được nhưng sai hoàn toàn — lọc theo giá trị của LIMIT.
   */
  const addParam = (v: unknown): string => {
    values.push(v);
    return `$${values.length}`;
  };
  const select: string[] = [];
  const groupBy: string[] = [];
  const columns: ReportColumn[] = [];
  /**
   * Mã cột kết quả → BIỂU THỨC SQL của nó.
   *
   * Cần vì PostgreSQL KHÔNG cho tham chiếu alias của SELECT trong HAVING
   * (chỉ ORDER BY và GROUP BY được). `HAVING THUC_NHAN > 0` nổ với
   * "column thuc_nhan does not exist" dù THUC_NHAN rõ ràng có trong SELECT.
   * Vậy ở HAVING phải phát lại `sum(ps.net_pay) > 0`.
   */
  const exprByCode = new Map<string, string>();

  // --- Chiều (GROUP BY) ----------------------------------------------------
  for (const d of def.dimensions) {
    const c = source.columns[d.field];
    if (!c) {
      throw new RangeError(`Cột '${d.field}' không có trong nguồn '${def.source}'.`);
    }
    select.push(`${c.column} AS ${quoteIdent(d.code)}`);
    groupBy.push(c.column);
    exprByCode.set(d.code, c.column);
    columns.push({ code: d.code, label: d.label, type: c.type, isMeasure: false });
  }

  // --- Chỉ tiêu -----------------------------------------------------------
  for (const m of def.measures) {
    const c = source.columns[m.field];
    if (!c) {
      throw new RangeError(`Cột '${m.field}' không có trong nguồn '${def.source}'.`);
    }
    // count() không cần cột cụ thể; các phép còn lại phải có cột số.
    const expr = m.aggregation === 'count' ? `count(${c.column})` : `${m.aggregation}(${c.column})`;
    select.push(`${expr} AS ${quoteIdent(m.code)}`);
    exprByCode.set(m.code, expr);
    // count luôn ra số nguyên; sum/avg của cột tiền vẫn là tiền.
    const type: ColumnType = m.aggregation === 'count' ? 'number' : c.type;
    columns.push({ code: m.code, label: m.label, type, isMeasure: true });
  }

  if (select.length === 0) {
    throw new RangeError('Báo cáo không có cột nào để hiển thị.');
  }

  // --- Lọc trước khi gộp (WHERE) ------------------------------------------
  const where: string[] = [];
  const having: string[] = [];
  const resultCode = new Set(columns.map((c) => c.code));

  for (const f of def.filters) {
    if (f.onResult) {
      // Lọc trên kết quả: tham chiếu alias đã gộp, nằm ở HAVING.
      if (!resultCode.has(f.field)) {
        throw new RangeError(`HAVING tham chiếu '${f.field}' không phải cột kết quả.`);
      }
      const col = columns.find((c) => c.code === f.field)!;
      const ph = addParam(coerce(f.value, col.type, `Điều kiện '${f.field}'`));
      const expr = exprByCode.get(f.field);
      if (!expr) {
        throw new RangeError(`HAVING tham chiếu '${f.field}' không có biểu thức tương ứng.`);
      }
      having.push(`${expr} ${sqlOp(f.op)} ${ph}`);
      continue;
    }

    const c = source.columns[f.field];
    if (!c) {
      throw new RangeError(`Cột lọc '${f.field}' không có trong nguồn '${def.source}'.`);
    }
    if (f.op === 'in') {
      const parts = f.value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      if (parts.length === 0) {
        throw new RangeError(`Điều kiện 'in' trên '${f.field}' không có giá trị nào.`);
      }
      const placeholders = parts.map((p) =>
        addParam(coerce(p, c.type, `Điều kiện '${f.field}'`)),
      );
      where.push(`${c.column} IN (${placeholders.join(', ')})`);
      continue;
    }
    if (f.op === 'like') {
      // Thêm % cho người dùng: họ gõ "kỹ" thì ý là "chứa kỹ".
      // Giá trị vẫn là tham số nên % và _ trong dữ liệu không gây hại.
      const ph = addParam(`%${f.value}%`);
      where.push(`${c.column} LIKE ${ph}`);
      continue;
    }
    const ph = addParam(coerce(f.value, c.type, `Điều kiện '${f.field}'`));
    where.push(`${c.column} ${sqlOp(f.op)} ${ph}`);
  }

  // --- Sắp xếp ------------------------------------------------------------
  const orderBy: string[] = [];
  for (const o of def.orderBy) {
    const c = source.columns[o.field];
    if (c) {
      orderBy.push(`${c.column} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`);
    } else if (resultCode.has(o.field)) {
      orderBy.push(`${quoteIdent(o.field)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`);
    } else {
      throw new RangeError(`Sắp xếp theo '${o.field}' không phải cột nguồn hay cột kết quả.`);
    }
  }

  const limitParam = addParam(def.limit);

  const sql =
    `SELECT ${select.join(', ')}\n` +
    `${source.from}\n` +
    (where.length > 0 ? `WHERE ${where.join(' AND ')}\n` : '') +
    (groupBy.length > 0 ? `GROUP BY ${groupBy.join(', ')}\n` : '') +
    (having.length > 0 ? `HAVING ${having.join(' AND ')}\n` : '') +
    (orderBy.length > 0 ? `ORDER BY ${orderBy.join(', ')}\n` : '') +
    `LIMIT ${limitParam}`;

  return { sql, values, columns };
}

/**
 * Bọc tên cột kết quả trong nháy kép.
 *
 * Không bọc thì PostgreSQL HẠ XUỐNG CHỮ THƯỜNG: `AS THUC_NHAN` thành alias
 * `thuc_nhan`, và người dùng chọn mã 'THỰC NHẬN' sẽ nhận về khoá không đoán
 * được. Bọc nháy thì giữ đúng chữ hoa chữ thường họ đã chọn.
 *
 * Nháy kép bên trong bị nhân đôi nên không thể thoát ra khỏi định danh.
 */
function quoteIdent(code: string): string {
  return `"${code.replace(/"/g, '""')}"`;
}

/** Phép so sánh → toán tử SQL. Whitelist, không bao giờ nhận chuỗi tự do. */
function sqlOp(op: string): string {
  switch (op) {
    case 'eq':
      return '=';
    case 'ne':
      return '<>';
    case 'gt':
      return '>';
    case 'gte':
      return '>=';
    case 'lt':
      return '<';
    case 'lte':
      return '<=';
    default:
      throw new RangeError(`Phép so sánh '${op}' không được hỗ trợ.`);
  }
}

/**
 * Chạy báo cáo.
 *
 * `executor` được tiêm vào thay vì import `getDb()` trực tiếp: engine này
 * thuần logic SQL, không nên biết database nằm ở đâu, và nhờ vậy test được mà
 * không cần PostgreSQL.
 */
export async function runReport(
  def: ReportParams,
  executor: (sql: string, values: unknown[]) => Promise<Record<string, unknown>[]>,
): Promise<ReportResult> {
  const query = buildReportQuery(def);
  const started = Date.now();
  const rows = await executor(query.sql, query.values);
  return { ...query, rows, durationMs: Date.now() - started };
}

/** Xuất CSV. Escape đúng chuẩn RFC 4180 — dấu phẩy và nháy kép trong dữ liệu. */
export function toCsv(
  columns: ReportColumn[],
  rows: Record<string, unknown>[],
  currency = '',
): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    // Bất kỳ ký tự đặc biệt nào cũng phải bọc nháy; nháy bên trong nhân đôi.
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const header = columns.map((c) => esc(c.label));
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      columns
        .map((c) => {
          const v = row[c.code.toLowerCase()] ?? row[c.code];
          // PostgreSQL trả tên cột viết thường; mã cột của ta viết HOA.
          return esc(
            typeof v === 'number' && c.type === 'money' && currency ? `${v} ${currency}` : v,
          );
        })
        .join(','),
    );
  }
  return lines.join('\n');
}
