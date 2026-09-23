/**
 * ============================================================================
 * ENGINE IN — ràng buộc dữ liệu vào mẫu, và chống XSS
 * ============================================================================
 *
 * CÚ PHÁP MẪU (cố tình nhỏ, để kiểm thử hết được):
 *   {{ truong }}                 escape HTML, định dạng theo `format`
 *   {{ truong | raw }}           KHÔNG escape — chỉ khi chắc chắn an toàn
 *   {{ truong | words }}         số thành chữ tiếng Việt
 *   {{ truong | upper|lower }}   đổi hoa/thường
 *   {{#each rows}} … {{/each}}   lặp; bên trong `this` là phần tử hiện tại
 *   {{#if cond}} … {{else}} … {{/if}}
 *   {{! chú thích }}             bỏ qua
 *
 * THỨ TỰ TRA CỨU một cái tên:
 *   1. trùng mã trường có biểu thức  → tính bằng formula engine
 *   2. trùng mã trường không biểu thức → lấy từ dữ liệu
 *   3. đường dẫn có chấm (a.b.c)     → lấy từ dữ liệu
 *
 * AN TOÀN:
 *   Dữ liệu LUÔN được escape, kể cả khi nó "chỉ là tên nhân viên". Một ô ghi
 *   chú chứa <script> mà không escape sẽ chạy trên máy kế toán trưởng mỗi lần
 *   in phiếu lương — stored XSS đúng nghĩa. Muốn chèn HTML thô phải viết
 *   `| raw` một cách CÓ CHỦ Ý, và điều đó sẽ hiện rõ khi đọc mẫu.
 */

import { evalFormula } from './formula.js';
import type { PrintField, PrintFormat } from '../policy/print-params.js';

// ---------------------------------------------------------------------------
// ESCAPE
// ---------------------------------------------------------------------------

/** Escape đủ 5 ký tự nguy hiểm trong cả nội dung thẻ và giá trị thuộc tính. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// SỐ THÀNH CHỮ TIẾNG VIỆT
// ---------------------------------------------------------------------------

const SO = ['không', 'một', 'hai', 'ba', 'bốn', 'năm', 'sáu', 'bảy', 'tám', 'chín'];
const BAC = ['', 'nghìn', 'triệu', 'tỷ'];

/**
 * Đọc một nhóm 3 chữ số. `isLeading` = đây là nhóm đầu tiên (không đọc
 * "không trăm" ở đầu).
 *
 * Ba quy tắc dễ sai của tiếng Việt:
 *   - hàng đơn vị sau hàng chục: 1 → "mốt", 4 → "lăm", 5 → "lăm"
 *   - số 0 ở giữa: 105 → "một trăm linh năm"
 *   - 101 → "một trăm linh một", KHÔNG phải "một trăm không mươi một"
 */
function docBaChuSo(n: number, isLeading: boolean): string {
  const tram = Math.floor(n / 100);
  const chuc = Math.floor((n % 100) / 10);
  const dv = n % 10;
  const out: string[] = [];

  if (tram > 0 || !isLeading) out.push(SO[tram]!, 'trăm');
  if (chuc === 0) {
    if (dv > 0 && (tram > 0 || !isLeading)) out.push('linh', SO[dv]!);
    else if (dv > 0) out.push(SO[dv]!);
  } else if (chuc === 1) {
    out.push('mười');
    if (dv === 5) out.push('lăm');
    else if (dv > 0) out.push(SO[dv]!);
  } else {
    out.push(SO[chuc]!, 'mươi');
    // Chỉ 1 và 5 đổi cách đọc sau hàng chục: 21 → "mốt", 25 → "lăm".
    // 4 vẫn đọc "bốn": 24 là "hai mươi bốn", KHÔNG phải "hai mươi lăm".
    // ("lăm" cho 4 là biến thể khẩu ngữ, không dùng trên chứng từ kế toán.)
    if (dv === 1) out.push('mốt');
    else if (dv === 5) out.push('lăm');
    else if (dv > 0) out.push(SO[dv]!);
  }
  return out.join(' ');
}

/** 1.234.567 → "một triệu hai trăm ba mươi bốn nghìn năm trăm sáu mươi bảy" */
export function soThanhChu(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`soThanhChu nhận giá trị không hữu hạn: ${value}`);
  }
  const am = value < 0;
  let n = Math.round(Math.abs(value));
  if (n === 0) return 'không đồng';
  if (n > 999_999_999_999) {
    throw new RangeError(`soThanhChu vượt quá khả năng đọc (nghìn tỷ): ${value}`);
  }

  const nhom: number[] = [];
  while (n > 0) {
    nhom.push(n % 1000);
    n = Math.floor(n / 1000);
  }

  const parts: string[] = [];
  for (let i = nhom.length - 1; i >= 0; i--) {
    const g = nhom[i]!;
    if (g === 0) continue;
    const doc = docBaChuSo(g, i === nhom.length - 1);
    parts.push(BAC[i] ? `${doc} ${BAC[i]}` : doc);
  }
  const text = parts.join(' ').replace(/\s+/g, ' ').trim();
  return `${am ? 'âm ' : ''}${text} đồng`;
}

// ---------------------------------------------------------------------------
// ĐỊNH DẠNG
// ---------------------------------------------------------------------------

export function formatValue(
  value: unknown,
  format: PrintFormat,
  decimals: number,
): string {
  switch (format) {
    case 'money': {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value ?? '');
      return n.toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + ' đ';
    }
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value ?? '');
      return n.toLocaleString('vi-VN', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }
    case 'percent': {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value ?? '');
      return (
        n.toLocaleString('vi-VN', {
          minimumFractionDigits: decimals,
          maximumFractionDigits: decimals,
        }) + '%'
      );
    }
    case 'date': {
      // Tự format dd/mm/yyyy thay vì toLocaleDateString: Node build với ICU rút
      // gọn sẽ cho ra "30/9/2026" (không đệm 0), và kết quả ĐỔI THEO môi
      // trường chạy. Trên chứng từ kế toán thì ngày phải ổn định tuyệt đối.
      const d = value instanceof Date ? value : new Date(String(value ?? ''));
      if (Number.isNaN(d.getTime())) return String(value ?? '');
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
    case 'upper':
      return String(value ?? '').toUpperCase();
    case 'text':
    default:
      return String(value ?? '');
  }
}

// ---------------------------------------------------------------------------
// TEMPLATE
// ---------------------------------------------------------------------------

export interface PrintData {
  [key: string]: unknown;
}

export interface RenderOptions {
  fields: PrintField[];
  /** Biến số học đưa vào formula engine. */
  numericInputs: Record<string, number>;
}

type Node =
  | { kind: 'text'; value: string }
  | { kind: 'expr'; name: string; filters: string[] }
  | { kind: 'each'; list: string; body: Node[] }
  | { kind: 'if'; cond: string; then: Node[]; els: Node[] };

/**
 * Phân tích mẫu thành cây.
 *
 * Viết parser thật (không phải replace chuỗi liên tiếp) vì lồng nhau là yêu
 * cầu có thật: {{#each}} chứa {{#if}} chứa {{ }}. Thay chuỗi từng lượt sẽ
 * hỏng ngay khi có một cấp lồng, và hỏng theo cách rất khó nhìn ra trên bản
 * in — thiếu một dòng trong bảng lương.
 */
export function parseTemplate(src: string): Node[] {
  // `#?else`: chấp nhận cả {{else}} (kiểu Handlebars) lẫn {{#else}}. Bắt buộc
  // phải nhận dạng `else` như một THẺ chứ không phải biểu thức — nếu không nó
  // sẽ được tra như một biến tên "else", trả về rỗng, và nhánh else biến mất
  // một cách im lặng.
  const TOKEN = /\{\{(#each|#if|#?else|\/each|\/if|!)?\s*([^}]*?)\s*\}\}/g;
  const nodes: Node[] = [];
  const stack: Node[][] = [nodes];
  // Ngăn xếp cho #if để ghép nhánh else
  const ifStack: Array<{ cond: string; then: Node[]; els: Node[] }> = [];

  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(src)) !== null) {
    const current = stack[stack.length - 1]!;
    if (m.index > last) current.push({ kind: 'text', value: src.slice(last, m.index) });
    last = m.index + m[0].length;

    const tag = m[1];
    const body = (m[2] ?? '').trim();

    if (tag === '!') continue;

    if (tag === '#each') {
      if (!body) throw new RangeError('{{#each}} thiếu tên danh sách');
      const child: Node[] = [];
      current.push({ kind: 'each', list: body, body: child });
      stack.push(child);
      continue;
    }
    if (tag === '/each') {
      if (stack.length <= 1) throw new RangeError('{{/each}} thừa, không có {{#each}} mở');
      stack.pop();
      continue;
    }
    if (tag === '#if') {
      if (!body) throw new RangeError('{{#if}} thiếu điều kiện');
      const thenNodes: Node[] = [];
      const elseNodes: Node[] = [];
      current.push({ kind: 'if', cond: body, then: thenNodes, els: elseNodes });
      ifStack.push({ cond: body, then: thenNodes, els: elseNodes });
      stack.push(thenNodes);
      continue;
    }
    if (tag === '#else' || tag === 'else') {
      const top = ifStack[ifStack.length - 1];
      if (!top) throw new RangeError('{{#else}} nằm ngoài {{#if}}');
      stack.pop();
      stack.push(top.els);
      continue;
    }
    if (tag === '/if') {
      if (ifStack.length === 0) throw new RangeError('{{/if}} thừa, không có {{#if}} mở');
      ifStack.pop();
      stack.pop();
      continue;
    }

    // Biểu thức thường, có thể kèm filter: "TEN | upper | raw"
    const parts = body.split('|').map((s) => s.trim());
    const name = parts[0] ?? '';
    if (!name) throw new RangeError('Biểu thức rỗng trong mẫu');
    current.push({ kind: 'expr', name, filters: parts.slice(1) });
  }
  if (last < src.length) stack[stack.length - 1]!.push({ kind: 'text', value: src.slice(last) });

  if (stack.length > 1) throw new RangeError('Mẫu thiếu thẻ đóng ({{/each}} hoặc {{/if}})');
  if (ifStack.length > 0) throw new RangeError('Mẫu thiếu {{/if}}');
  return nodes;
}

/** Lấy giá trị theo đường dẫn có chấm: "employee.name" */
function resolvePath(data: PrintData, path: string): unknown {
  if (path === 'this') return data;
  let cur: unknown = data;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    // hasOwnProperty: không cho mẫu với tới constructor/__proto__ của dữ liệu
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** Điều kiện {{#if}}: số khác 0, chuỗi không rỗng, mảng không rỗng, boolean. */
function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (typeof v === 'number') return Number.isFinite(v) && v !== 0;
  if (typeof v === 'string') return v.trim() !== '';
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

export function renderTemplate(body: string, data: PrintData, opts: RenderOptions): string {
  const nodes = parseTemplate(body);
  const fieldByCode = new Map(opts.fields.map((f) => [f.code, f]));

  const render = (list: Node[], scope: PrintData): string =>
    list
      .map((n) => {
        switch (n.kind) {
          case 'text':
            return n.value;
          case 'each': {
            const arr = resolvePath(scope, n.list);
            if (arr === undefined || arr === null) return '';
            if (!Array.isArray(arr)) {
              throw new RangeError(
                `{{#each ${n.list}}}: '${n.list}' không phải mảng (nhận ${typeof arr}).`,
              );
            }
            return arr
              .map((item) => {
                // Phần tử mảng kế thừa phạm vi cha, và `this` trỏ tới chính nó.
                const child: PrintData =
                  item !== null && typeof item === 'object' && !Array.isArray(item)
                    ? { ...scope, ...(item as PrintData), this: item }
                    : { ...scope, this: item };
                return render(n.body, child);
              })
              .join('');
          }
          case 'if': {
            const v = resolvePath(scope, n.cond);
            return truthy(v) ? render(n.then, scope) : render(n.els, scope);
          }
          case 'expr': {
            const field = fieldByCode.get(n.name);
            const raw = n.filters.includes('raw');
            const words = n.filters.includes('words');

            let value: unknown;
            let format: PrintFormat = field?.format ?? 'text';
            const decimals = field?.decimals ?? 0;

            if (field && field.expr && field.expr.trim() !== '') {
              // Trường có biểu thức: tính bằng formula engine trên biến số học.
              // onMissingVar/onDivisionByZero = throw: một trường in sai thì thà
              // dừng lại còn hơn in ra một phiếu lương thiếu tiền.
              value = evalFormula(field.expr, opts.numericInputs, {
                onMissingVar: 'throw',
                onDivisionByZero: 'throw',
              });
            } else if (field) {
              value = resolvePath(scope, n.name);
            } else {
              value = resolvePath(scope, n.name);
            }

            if (words) {
              const num = Number(value);
              if (!Number.isFinite(num)) {
                throw new RangeError(
                  `{{ ${n.name} | words }}: giá trị không phải số (${String(value)}).`,
                );
              }
              return raw ? soThanhChu(num) : escapeHtml(soThanhChu(num));
            }

            const text = formatValue(value, format, decimals);
            return raw ? text : escapeHtml(text);
          }
          default:
            return '';
        }
      })
      .join('');

  return render(nodes, data);
}

// ---------------------------------------------------------------------------
// TÀI LIỆU IN HOÀN CHỈNH
// ---------------------------------------------------------------------------

export interface DocumentOptions {
  title: string;
  paperSize: 'A4' | 'A5' | 'LETTER';
  orientation: 'portrait' | 'landscape';
  marginMm: { top: number; right: number; bottom: number; left: number };
  css: string;
  /** Nội dung đã render từ mẫu. */
  content: string;
  /** Tên công ty / tiêu đề trang, dùng cho <title> và header trình duyệt. */
  lang?: string;
}

/**
 * Bọc nội dung thành một tài liệu HTML in được.
 *
 * `title` được escape; `css` và `content` thì không — chúng do quản trị soạn
 * và đã được kiểm tra ở tầng schema (chặn <script> và thuộc tính sự kiện).
 */
export function renderDocument(o: DocumentOptions): string {
  const size = `${o.paperSize} ${o.orientation}`;
  return `<!doctype html>
<html lang="${o.lang ?? 'vi'}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(o.title)}</title>
<style>
  @page { size: ${size}; margin: ${o.marginMm.top}mm ${o.marginMm.right}mm ${o.marginMm.bottom}mm ${o.marginMm.left}mm; }
  html, body { margin: 0; padding: 0; }
  body { padding: 16px; }
  @media print { body { padding: 0; } }
</style>
<style>
${o.css}
</style>
</head>
<body>
${o.content}
</body>
</html>`;
}
