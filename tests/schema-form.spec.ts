/**
 * Kiểm chứng thành phần then chốt của UI: form TỰ SINH từ JSON Schema.
 *
 * Đây là thứ làm cho "sửa luật trên giao diện" thành sự thật. Nếu nó sai thì
 * giao diện sinh ra form rỗng hoặc thiếu trường, và người dùng sẽ điền thiếu
 * tham số pháp lý mà không biết.
 */
import { describe, it, expect } from 'vitest';
import {
  defaultsFromSchema,
  validateAgainstSchema,
  type JsonSchema,
} from '../src/components/schema-form.js';
import { vnPitJsonSchema, vnPitParamsSchema } from '../src/policy/tax-params.js';

const SCHEMA = vnPitJsonSchema as unknown as JsonSchema;

/**
 * `vnPitParamsSchema` là ZodEffects chứ không phải ZodObject, vì nó kết thúc
 * bằng `.superRefine(...)` (các quy tắc kiểm tra chéo giữa các bậc thuế).
 * ZodEffects không có `.shape` — phải unwrap một lớp để lấy ZodObject bên trong.
 *
 * Viết helper thay vì truy cập `_def.schema` rải rác: nếu nâng cấp Zod mà cấu
 * trúc nội bộ đổi, chỉ một chỗ này cần sửa.
 */
function shapeOf(schema: unknown): Record<string, { isOptional(): boolean }> {
  const def = (schema as { _def: { typeName?: string; schema?: unknown } })._def;
  const target = def.typeName === 'ZodObject' ? schema : def.schema;
  return (target as { shape: Record<string, { isOptional(): boolean }> }).shape;
}

describe('defaultsFromSchema — sinh giá trị khởi tạo cho form', () => {
  it('sinh đủ MỌI khoá khai báo trong JSON Schema (không sót trường nào)', () => {
    const defaults = defaultsFromSchema(SCHEMA);
    const expected = Object.keys(SCHEMA.properties ?? {});
    expect(Object.keys(defaults).sort()).toEqual(expected.sort());
  });

  it('array khởi tạo rỗng — người dùng tự thêm dòng bậc thuế', () => {
    const defaults = defaultsFromSchema(SCHEMA);
    expect(defaults.brackets).toEqual([]);
  });

  it('number khởi tạo bằng `minimum` nếu có, để form không mở ra với 0 vô nghĩa', () => {
    const defaults = defaultsFromSchema(SCHEMA);
    // selfDeduction có minimum trong schema (không được âm) → lấy minimum
    const min = (SCHEMA.properties?.selfDeduction as JsonSchema | undefined)?.minimum;
    expect(defaults.selfDeduction).toBe(min ?? 0);
  });

  it('string khởi tạo rỗng, boolean khởi tạo false', () => {
    const defaults = defaultsFromSchema({
      type: 'object',
      properties: {
        code: { type: 'string' },
        enabled: { type: 'boolean' },
        nested: { type: 'object', properties: { x: { type: 'integer' } } },
      },
    });
    expect(defaults).toEqual({ code: '', enabled: false, nested: { x: 0 } });
  });
});

describe('JSON Schema và Zod schema KHÔNG ĐƯỢC lệch nhau', () => {
  /**
   * Hai thứ này mô tả CÙNG một bộ tham số nhưng ở hai tầng:
   *   - JSON Schema  → giao diện dùng để TỰ SINH form
   *   - Zod schema   → backend dùng để validate trước khi ghi DB
   *
   * Nếu lệch: form sinh ra trường mà backend từ chối (người dùng không lưu
   * được), hoặc ngược lại — backend nhận trường mà form không cho điền, nên
   * giá trị bị thiếu âm thầm. Cả hai đều phá vỡ lời hứa "thêm một loại chính
   * sách = thêm một schema". Test này bắt lỗi đó ngay khi thêm trường mới.
   */
  it('cùng tập tên trường', () => {
    const fromJson = Object.keys(SCHEMA.properties ?? {}).sort();
    const fromZod = Object.keys(shapeOf(vnPitParamsSchema)).sort();
    expect(fromJson).toEqual(fromZod);
  });

  it('cùng danh sách trường bắt buộc', () => {
    const jsonRequired = [...(SCHEMA.required ?? [])].sort();
    // Zod: trường không optional → required
    const zodRequired = Object.entries(shapeOf(vnPitParamsSchema))
      .filter(([, s]) => !s.isOptional())
      .map(([k]) => k)
      .sort();
    expect(jsonRequired).toEqual(zodRequired);
  });

  it('bậc thuế: JSON Schema và Zod cùng mô tả 3 thuộc tính', () => {
    const bracketProps = Object.keys(
      (SCHEMA.properties?.brackets as JsonSchema)?.items?.properties ?? {},
    ).sort();
    expect(bracketProps).toEqual(['quickDeduction', 'rate', 'upto']);
  });

  it('một bộ giá trị hợp lệ theo Zod thì form cũng điền đủ được (khớp kiểu)', () => {
    // Lấy defaults, điền tay đúng những gì form cho phép, rồi validate bằng Zod
    const filled = {
      regimeCode: 'TEST_SCHEMA_FORM',
      regimeLabel: 'Sinh từ schema',
      selfDeduction: 15_500_000,
      dependentDeduction: 6_200_000,
      voluntaryPensionCapMonthly: 1_000_000,
      exemptMealCapMonthly: 730_000,
      brackets: [
        { upto: 10_000_000, rate: 0.05, quickDeduction: 0 },
        { upto: 30_000_000, rate: 0.1, quickDeduction: 500_000 },
        { upto: null, rate: 0.2, quickDeduction: 3_500_000 },
      ],
    };
    const parsed = vnPitParamsSchema.safeParse(filled);
    expect(parsed.success).toBe(true);
  });
});

describe('validateAgainstSchema — chặn submit khi thiếu tham số pháp lý', () => {
  /**
   * Regression cho bug thật: `exemptMealCapMonthly` bị thiếu trong
   * `required` của JSON Schema (do bỏ .default(0) ở Zod mà quên cập nhật
   * JSON Schema). Vì trường số để trống được gửi lên là 0 và Zod chấp nhận
   * 0 (minimum = 0), một bộ tham số QUÊN ĐIỀN trần ăn ca sẽ lưu được thành
   * 0đ → người lao động bị đánh thuế oan trên tiền ăn ca, không log nào báo.
   */
  it('bắt lỗi khi thiếu exemptMealCapMonthly (bug từng lọt qua)', () => {
    const issues = validateAgainstSchema(SCHEMA, {
      regimeCode: 'X',
      regimeLabel: 'Thiếu trần ăn ca',
      selfDeduction: 15_500_000,
      dependentDeduction: 6_200_000,
      voluntaryPensionCapMonthly: 1_000_000,
      brackets: [
        { upto: 10_000_000, rate: 0.05, quickDeduction: 0 },
        { upto: null, rate: 0.1, quickDeduction: 500_000 },
      ],
    });
    const paths = issues.map((i) => i.path.join('.'));
    expect(paths).toContain('exemptMealCapMonthly');
  });

  it('giá trị mặc định do defaultsFromSchema sinh ra KHÔNG được phép lưu', () => {
    // defaultsFromSchema chỉ dựng cấu trúc; người dùng bắt buộc phải điền.
    // Nếu test này fail thì form đang cho lưu một bộ tham số rỗng.
    const issues = validateAgainstSchema(SCHEMA, defaultsFromSchema(SCHEMA));
    expect(issues.length).toBeGreaterThan(0);
    // brackets rỗng phải bị chặn — không có bậc thuế thì không tính được thuế
    expect(issues.map((i) => i.path.join('.'))).toContain('brackets');
  });

  it('bộ tham số đầy đủ thì không có lỗi nào', () => {
    const issues = validateAgainstSchema(SCHEMA, {
      regimeCode: 'OK',
      regimeLabel: 'Đầy đủ',
      selfDeduction: 15_500_000,
      dependentDeduction: 6_200_000,
      voluntaryPensionCapMonthly: 1_000_000,
      exemptMealCapMonthly: 730_000,
      brackets: [
        { upto: 10_000_000, rate: 0.05, quickDeduction: 0 },
        { upto: null, rate: 0.1, quickDeduction: 500_000 },
      ],
    });
    expect(issues).toEqual([]);
  });

  it('báo đúng đường dẫn tới dòng bậc thuế bị thiếu trường', () => {
    const issues = validateAgainstSchema(SCHEMA, {
      regimeCode: 'X',
      regimeLabel: 'Thiếu upto',
      selfDeduction: 0,
      dependentDeduction: 0,
      voluntaryPensionCapMonthly: 0,
      exemptMealCapMonthly: 0,
      brackets: [
        { upto: 10_000_000, rate: 0.05, quickDeduction: 0 },
        { rate: 0.1, quickDeduction: 500_000 },
      ],
    });
    // upto khai báo type ['integer','null'] nên null hợp lệ, nhưng thiếu hẳn
    // (undefined) thì phải báo, kèm chỉ số dòng để form tô đỏ đúng ô
    expect(issues.map((i) => i.path.join('.'))).toContain('brackets.1.upto');
  });

  it('chặn số âm và số không nguyên với trường tiền', () => {
    const issues = validateAgainstSchema(SCHEMA, {
      regimeCode: 'X',
      regimeLabel: 'Sai số',
      selfDeduction: -1,
      dependentDeduction: 1.5,
      voluntaryPensionCapMonthly: 0,
      exemptMealCapMonthly: 0,
      brackets: [{ upto: null, rate: 0.05, quickDeduction: 0 }],
    });
    const byPath = Object.fromEntries(issues.map((i) => [i.path.join('.'), i.message]));
    expect(byPath.selfDeduction).toMatch(/không được nhỏ hơn/i);
    expect(byPath.dependentDeduction).toMatch(/số nguyên/i);
  });
});
