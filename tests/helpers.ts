/**
 * Helper dùng chung cho các test về policy params.
 */
import type { z } from 'zod';

/**
 * Lấy `shape` của một Zod schema, kể cả khi nó bị bọc NHIỀU LỚP.
 *
 * Các schema tham số đều kết thúc bằng `.superRefine(...)` / `.refine(...)` để
 * kiểm tra ràng buộc chéo giữa các trường, và mỗi lần gọi trả về một ZodEffects
 * — thứ KHÔNG có `.shape`.
 *
 * VÒNG LẶP chứ không unwrap một lớp: bản trước chỉ unwrap một lớp, và GEOFENCE
 * dùng HAI `.refine()` liên tiếp nên bọc thành ZodEffects(ZodEffects(ZodObject)).
 * Kết quả là `Object.entries(undefined)` và thông báo "Cannot convert undefined
 * or null to object" — không nói gì về nguyên nhân thật. Một helper dùng chung
 * mà chỉ đúng với một độ sâu là cái bẫy cho người thêm ràng buộc thứ hai.
 */
export function shapeOf(schema: unknown): Record<string, z.ZodTypeAny> {
  let cur = schema as { _def: { typeName?: string; schema?: unknown }; shape?: unknown };
  // Giới hạn 20 lớp: đủ cho mọi trường hợp thật, và không treo vô hạn nếu Zod
  // đổi cấu trúc nội bộ khiến vòng lặp không bao giờ gặp ZodObject.
  for (let i = 0; i < 20; i += 1) {
    if (cur._def?.typeName === 'ZodObject') break;
    const next = cur._def?.schema as typeof cur | undefined;
    if (!next) {
      throw new Error(
        `shapeOf: không tìm thấy ZodObject sau ${i} lớp bọc (typeName cuối = ${cur._def?.typeName})`,
      );
    }
    cur = next;
  }
  if (!cur.shape) {
    throw new Error(`shapeOf: schema không có .shape (typeName = ${cur._def?.typeName})`);
  }
  return cur.shape as Record<string, z.ZodTypeAny>;
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
