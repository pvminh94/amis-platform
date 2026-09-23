/**
 * ============================================================================
 * TEST — ENGINE IN (định dạng, template, chống XSS, số thành chữ)
 * ============================================================================
 */
import { describe, it, expect } from 'vitest';
import {
  printParamsSchema,
  printJsonSchema,
  SEED_PRINT_PAYSLIP,
  type PrintParams,
  type PrintField,
} from '../src/policy/print-params.js';
import {
  escapeHtml,
  soThanhChu,
  formatValue,
  parseTemplate,
  renderTemplate,
  renderDocument,
} from '../src/engine/print.js';
import { expectSchemasAgree } from './helpers.js';

const F = (code: string, expr: string, format: PrintField['format'] = 'money', decimals = 0): PrintField => ({
  code,
  label: code,
  expr,
  format,
  decimals,
});

// ---------------------------------------------------------------------------
// 1. SCHEMA
// ---------------------------------------------------------------------------

describe('PRINT: JSON Schema và Zod schema khớp nhau', () => {
  it('cùng tập tên trường và cùng danh sách bắt buộc', () => {
    const { jsonFields } = expectSchemasAgree(printJsonSchema, printParamsSchema);
    expect(jsonFields).toContain('body');
    expect(jsonFields).toContain('marginMm');
  });

  it('seed phiếu lương parse được', () => {
    expect(printParamsSchema.safeParse(SEED_PRINT_PAYSLIP).success).toBe(true);
  });

  it('mẫu chứa <script> bị chặn lúc lưu', () => {
    const r = printParamsSchema.safeParse({
      ...SEED_PRINT_PAYSLIP,
      body: '<h1>X</h1><script>alert(1)</script>',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/script/);
  });

  it('mẫu chứa thuộc tính sự kiện (onclick=) bị chặn', () => {
    const r = printParamsSchema.safeParse({
      ...SEED_PRINT_PAYSLIP,
      body: '<div onclick="evil()">X</div>',
    });
    expect(r.success).toBe(false);
  });

  it('biểu thức dùng biến chưa khai báo bị chặn', () => {
    const r = printParamsSchema.safeParse({
      ...SEED_PRINT_PAYSLIP,
      fields: [F('X', 'grosss * 2', 'money')], // gõ thiếu chữ
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/grosss/);
  });

  it('trùng mã trường bị chặn', () => {
    const r = printParamsSchema.safeParse({
      ...SEED_PRINT_PAYSLIP,
      fields: [F('X', 'gross'), F('X', 'pit')],
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toMatch(/bị trùng/);
  });
});

// ---------------------------------------------------------------------------
// 2. SỐ THÀNH CHỮ — quy tắc tiếng Việt rất dễ sai
// ---------------------------------------------------------------------------

describe('soThanhChu', () => {
  const cases: Array<[number, string]> = [
    [0, 'không đồng'],
    [1, 'một đồng'],
    [5, 'năm đồng'],
    [10, 'mười đồng'],
    [11, 'mười một đồng'],
    [14, 'mười bốn đồng'],
    [15, 'mười lăm đồng'],
    [20, 'hai mươi đồng'],
    [21, 'hai mươi mốt đồng'],
    [24, 'hai mươi bốn đồng'],
    [25, 'hai mươi lăm đồng'],
    [100, 'một trăm đồng'],
    [101, 'một trăm linh một đồng'],
    [105, 'một trăm linh năm đồng'],
    [110, 'một trăm mười đồng'],
    [1000, 'một nghìn đồng'],
    [1000000, 'một triệu đồng'],
    [42_910_500, 'bốn mươi hai triệu chín trăm mười nghìn năm trăm đồng'],
  ];
  for (const [n, want] of cases) {
    it(`${n} → "${want}"`, () => {
      expect(soThanhChu(n)).toBe(want);
    });
  }

  it('số âm đọc "âm …"', () => {
    expect(soThanhChu(-500)).toBe('âm năm trăm đồng');
  });

  it('làm tròn số lẻ trước khi đọc (tiền không có số lẻ)', () => {
    expect(soThanhChu(1500.4)).toBe('một nghìn năm trăm đồng');
  });

  it('NaN / Infinity → ném lỗi, không đọc bừa', () => {
    expect(() => soThanhChu(Number.NaN)).toThrow(RangeError);
    expect(() => soThanhChu(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// 3. ESCAPE — đây là chỗ quan trọng nhất của cả engine in
// ---------------------------------------------------------------------------

describe('escapeHtml: dữ liệu in ra KHÔNG bao giờ thành HTML', () => {
  it('escape đủ 5 ký tự nguy hiểm', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe(
      '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;',
    );
  });

  it('một ô ghi chú chứa script sẽ bị vô hiệu hoá khi render', () => {
    const html = renderTemplate('Lý do: {{ LY_DO }}', { LY_DO: '<img src=x onerror=alert(1)>' }, {
      fields: [{ code: 'LY_DO', label: 'Lý do', expr: '', format: 'text', decimals: 0 }],
      numericInputs: {},
    });
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });

  it('`| raw` là cách DUY NHẤT để chèn HTML thô, và phải viết có chủ ý', () => {
    const opts = {
      fields: [{ code: 'X', label: 'X', expr: '', format: 'text' as const, decimals: 0 }],
      numericInputs: {},
    };
    expect(renderTemplate('{{ X }}', { X: '<b>a</b>' }, opts)).toBe('&lt;b&gt;a&lt;/b&gt;');
    expect(renderTemplate('{{ X | raw }}', { X: '<b>a</b>' }, opts)).toBe('<b>a</b>');
  });
});

// ---------------------------------------------------------------------------
// 4. ĐỊNH DẠNG
// ---------------------------------------------------------------------------

describe('formatValue', () => {
  it('money: phân cách kiểu VN và kèm "đ"', () => {
    expect(formatValue(42_910_500, 'money', 0)).toMatch(/42\.910\.500/);
    expect(formatValue(42_910_500, 'money', 0)).toContain('đ');
  });
  it('percent: kèm %', () => {
    expect(formatValue(4.74, 'percent', 2)).toContain('%');
  });
  it('date: ISO → dd/mm/yyyy', () => {
    expect(formatValue('2026-09-30', 'date', 0)).toBe('30/09/2026');
  });
  it('giá trị không phải số với format money → trả nguyên văn, không ra "NaN đ"', () => {
    expect(formatValue('chưa có', 'money', 0)).toBe('chưa có');
  });
  it('ngày sai → trả nguyên văn, không ra "Invalid Date"', () => {
    expect(formatValue('không phải ngày', 'date', 0)).toBe('không phải ngày');
  });
});

// ---------------------------------------------------------------------------
// 5. TEMPLATE
// ---------------------------------------------------------------------------

describe('renderTemplate', () => {
  const opts = {
    fields: [
      F('THUC_NHAN', 'gross - tax', 'money'),
      F('TEN_NV', '', 'upper'),
      F('GHI_CHU', '', 'text'),
    ],
    numericInputs: { gross: 50_000_000, tax: 2_000_000 },
  };

  it('trường có biểu thức được tính bằng formula engine', () => {
    const html = renderTemplate('{{ THUC_NHAN }}', {}, opts);
    expect(html).toMatch(/48\.000\.000/);
  });

  it('trường không biểu thức lấy thẳng từ dữ liệu', () => {
    expect(renderTemplate('{{ TEN_NV }}', { TEN_NV: 'nguyễn văn a' }, opts)).toBe(
      'NGUYỄN VĂN A',
    );
  });

  it('biểu thức chia cho 0 → ném lỗi, không in ra số sai', () => {
    const bad = {
      fields: [F('X', 'a / b', 'money')],
      numericInputs: { a: 1, b: 0 },
    };
    expect(() => renderTemplate('{{ X }}', {}, bad)).toThrow(/Chia cho 0/);
  });

  it('biểu thức dùng biến không có → ném lỗi', () => {
    const bad = { fields: [F('X', 'khongCo', 'money')], numericInputs: {} };
    expect(() => renderTemplate('{{ X }}', {}, bad)).toThrow(/khongCo/);
  });

  it('{{#each}} lặp bảng', () => {
    const html = renderTemplate(
      '<ul>{{#each dong}}<li>{{ ten }}: {{ soTien }}</li>{{/each}}</ul>',
      { dong: [{ ten: 'Lương', soTien: 1 }, { ten: 'Thưởng', soTien: 2 }] },
      { fields: [], numericInputs: {} },
    );
    expect(html).toBe('<ul><li>Lương: 1</li><li>Thưởng: 2</li></ul>');
  });

  it('dữ liệu trong vòng lặp vẫn bị escape', () => {
    const html = renderTemplate(
      '{{#each d}}{{ ten }}{{/each}}',
      { d: [{ ten: '<script>x</script>' }] },
      { fields: [], numericInputs: {} },
    );
    expect(html).not.toContain('<script>');
  });

  it('{{#if}}/{{#else}}', () => {
    const o = { fields: [], numericInputs: {} };
    expect(renderTemplate('{{#if ok}}có{{else}}không{{/if}}', { ok: true }, o)).toBe('có');
    expect(renderTemplate('{{#if ok}}có{{else}}không{{/if}}', { ok: false }, o)).toBe('không');
    // mảng rỗng = false, mảng có phần tử = true
    expect(renderTemplate('{{#if l}}có{{else}}không{{/if}}', { l: [] }, o)).toBe('không');
    expect(renderTemplate('{{#if l}}có{{else}}không{{/if}}', { l: [1] }, o)).toBe('có');
  });

  it('lồng nhau: {{#each}} chứa {{#if}} chứa {{ }}', () => {
    const html = renderTemplate(
      '{{#each d}}[{{#if am}}-{{/if}}{{ ten }}]{{/each}}',
      { d: [{ ten: 'a', am: true }, { ten: 'b', am: false }] },
      { fields: [], numericInputs: {} },
    );
    expect(html).toBe('[-a][b]');
  });

  it('{{! chú thích }} bị bỏ qua', () => {
    expect(renderTemplate('a{{! đây là chú thích }}b', {}, { fields: [], numericInputs: {} })).toBe(
      'ab',
    );
  });

  it('đường dẫn có chấm', () => {
    expect(
      renderTemplate('{{ nv.hoTen }}', { nv: { hoTen: 'A' } }, { fields: [], numericInputs: {} }),
    ).toBe('A');
  });

  it('danh sách không tồn tại → in rỗng, không ném lỗi', () => {
    expect(
      renderTemplate('x{{#each khongCo}}y{{/each}}z', {}, { fields: [], numericInputs: {} }),
    ).toBe('xz');
  });

  it('{{#each}} trên thứ không phải mảng → ném lỗi rõ ràng', () => {
    expect(() =>
      renderTemplate('{{#each x}}y{{/each}}', { x: 'chuỗi' }, { fields: [], numericInputs: {} }),
    ).toThrow(/không phải mảng/);
  });

  it('mẫu không cân bằng thẻ → ném lỗi lúc parse', () => {
    expect(() => parseTemplate('{{#each a}}x')).toThrow(/thiếu thẻ đóng/);
    expect(() => parseTemplate('{{/each}}')).toThrow(/thừa/);
    expect(() => parseTemplate('{{#else}}')).toThrow(/ngoài/);
    expect(() => parseTemplate('{{#if a}}x{{/if}}{{/if}}')).toThrow(/thừa/);
    expect(() => parseTemplate('{{ }}')).toThrow(/rỗng/);
    expect(() => parseTemplate('{{#each}}x{{/each}}')).toThrow(/thiếu tên/);
  });

  it('không với tới được prototype của dữ liệu', () => {
    const o = { fields: [], numericInputs: {} };
    expect(renderTemplate('[{{ constructor }}]', {}, o)).toBe('[]');
    expect(renderTemplate('[{{ __proto__ }}]', {}, o)).toBe('[]');
    expect(renderTemplate('[{{ a.constructor }}]', { a: {} }, o)).toBe('[]');
  });

  it('filter | words chuyển số thành chữ', () => {
    expect(
      renderTemplate('{{ TIEN | words }}', { TIEN: 1500 }, { fields: [], numericInputs: {} }),
    ).toBe('một nghìn năm trăm đồng');
  });

  it('| words trên giá trị không phải số → ném lỗi', () => {
    expect(() =>
      renderTemplate('{{ X | words }}', { X: 'abc' }, { fields: [], numericInputs: {} }),
    ).toThrow(/không phải số/);
  });
});

// ---------------------------------------------------------------------------
// 6. TÀI LIỆU IN
// ---------------------------------------------------------------------------

describe('renderDocument', () => {
  const doc = renderDocument({
    title: 'Phiếu lương <script>x</script>',
    paperSize: 'A4',
    orientation: 'portrait',
    marginMm: { top: 15, right: 15, bottom: 15, left: 15 },
    css: 'body{color:red}',
    content: '<h1>Nội dung</h1>',
  });

  it('khai báo @page đúng khổ và lề', () => {
    expect(doc).toContain('@page { size: A4 portrait; margin: 15mm 15mm 15mm 15mm; }');
  });
  it('title bị escape', () => {
    expect(doc).toContain('&lt;script&gt;');
    expect(doc).not.toContain('<title>Phiếu lương <script>');
  });
  it('css và content được chèn nguyên văn (do quản trị soạn)', () => {
    expect(doc).toContain('body{color:red}');
    expect(doc).toContain('<h1>Nội dung</h1>');
  });
  it('landscape và khổ khác', () => {
    const d = renderDocument({
      title: 'x',
      paperSize: 'A5',
      orientation: 'landscape',
      marginMm: { top: 10, right: 10, bottom: 10, left: 10 },
      css: '',
      content: '',
    });
    expect(d).toContain('size: A5 landscape');
  });
});

// ---------------------------------------------------------------------------
// 7. MẪU SEED PHẢI RENDER ĐƯỢC
// ---------------------------------------------------------------------------

describe('Mẫu phiếu lương seed', () => {
  const numericInputs = {
    gross: 49_670_000,
    siEmployee: 2_625_000,
    pit: 2_034_500,
    advance: 2_000_000,
    dependents: 1,
    workedDays: 22,
    standardDays: 22,
  };
  const data = {
    TEN_NV: 'nguyễn văn a',
    KY_LUONG: '09/2026',
    BO_PHAN: 'Kỹ thuật',
    NGAY_IN: '2026-09-30',
    standardDays: 22,
    dependents: 1,
  };

  it('render không lỗi và có đủ các mốc tiền', () => {
    const html = renderTemplate(SEED_PRINT_PAYSLIP.body, data, {
      fields: SEED_PRINT_PAYSLIP.fields,
      numericInputs,
    });
    // Thực nhận = 49.670.000 − 2.625.000 − 2.034.500 − 2.000.000 = 43.010.500
    expect(html).toMatch(/43\.010\.500/);
    expect(html).toMatch(/49\.670\.500|49\.670\.000/);
    expect(html).toContain('NGUYỄN VĂN A'); // format: upper
    expect(html).toContain('30/09/2026'); // format: date
  });

  it('số tiền bằng chữ đúng', () => {
    const html = renderTemplate(SEED_PRINT_PAYSLIP.body, data, {
      fields: SEED_PRINT_PAYSLIP.fields,
      numericInputs,
    });
    expect(html).toContain(
      'bốn mươi ba triệu không trăm mười nghìn năm trăm đồng',
    );
  });

  it('tên nhân viên chứa HTML vẫn an toàn', () => {
    const html = renderTemplate(
      SEED_PRINT_PAYSLIP.body,
      { ...data, TEN_NV: '<script>evil()</script>' },
      { fields: SEED_PRINT_PAYSLIP.fields, numericInputs },
    );
    expect(html).not.toContain('<script>evil');
  });

  it('mẫu seed parse được thành cây hợp lệ', () => {
    expect(() => parseTemplate(SEED_PRINT_PAYSLIP.body)).not.toThrow();
  });
});
