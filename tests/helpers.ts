/**
 * Helper dùng chung cho các test về policy params.
 */
import type { z } from 'zod';

/**
 * Lấy `shape` của một Zod schema, kể cả khi nó bị bọc.
 *
 * Các schema tham số đều kết thúc bằng `.superRefine(...)` để kiểm tra ràng
 * buộc chéo giữa các trường, và `.superRefine` trả về ZodEffects — thứ KHÔNG
 * có `.shape`. Phải unwrap một lớp để lấy ZodObject bên trong.
 *
 * Viết một chỗ duy nhất: nếu nâng cấp Zod mà cấu trúc nội bộ đổi thì chỉ
 * một file này cần sửa.
 */
export function shapeOf(schema: unknown): Record<string, z.ZodTypeAny> {
  const def = (schema as { _def: { typeName?: string; schema?: unknown } })._def;
  const target = def.typeName === 'ZodObject' ? schema : def.schema;
  return (target as { shape: Record<string, z.ZodTypeAny> }).shape;
}

/** Danh sách trường BẮT BUỘC theo Zod (không optional). */
export function zodRequired(schema: unknown): string[] {
  return Object.entries(shapeOf(schema))
    .filter(([, s]) => !s.isOptional())
    .map(([k]) => k)
    .sort();
}

/**
 * So sánh JSON Schema với Zod schema — phải khớp cả tên trường lẫn danh sách
 * bắt buộc.
 *
 * Đây không phải test hình thức. Mỗi loại chính sách có HAI bản mô tả: JSON
 * Schema để giao diện tự sinh form, Zod để backend validate. Lệch nhau một
 * trường là form cho phép lưu thiếu một tham số pháp lý mà không ai biết —
 * đã xảy ra thật với `exemptMealCapMonthly` ở VN_PIT.
 */
export function expectSchemasAgree(
  // readonly: các JSON Schema được khai báo `as const` nên required là readonly tuple
  jsonSchema: { properties?: Record<string, unknown>; required?: readonly string[] },
  zodSchema: unknown,
): { jsonFields: string[]; zodFields: string[] } {
  const jsonFields = Object.keys(jsonSchema.properties ?? {}).sort();
  const zodFields = Object.keys(shapeOf(zodSchema)).sort();
  if (JSON.stringify(jsonFields) !== JSON.stringify(zodFields)) {
    throw new Error(
      `Tập trường lệch nhau.\n  chỉ có trong JSON Schema: ${jsonFields.filter((f) => !zodFields.includes(f)).join(', ') || '(không)'}\n  chỉ có trong Zod: ${zodFields.filter((f) => !jsonFields.includes(f)).join(', ') || '(không)'}`,
    );
  }
  const jsonRequired = [...(jsonSchema.required ?? [])].sort();
  const zodReq = zodRequired(zodSchema);
  if (JSON.stringify(jsonRequired) !== JSON.stringify(zodReq)) {
    throw new Error(
      `Danh sách bắt buộc lệch nhau.\n  JSON Schema: ${jsonRequired.join(', ')}\n  Zod        : ${zodReq.join(', ')}`,
    );
  }
  return { jsonFields, zodFields };
}
