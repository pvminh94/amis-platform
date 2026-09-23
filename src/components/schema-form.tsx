'use client';

/**
 * ============================================================================
 * SCHEMA FORM — tự sinh form chỉnh sửa từ JSON Schema
 * ============================================================================
 *
 * ĐÂY LÀ COMPONENT QUYẾT ĐỊNH GIÁ TRỊ CỦA CẢ KIẾN TRÚC.
 *
 * policy_kinds.params_schema lưu JSON Schema mô tả cấu trúc tham số. Component
 * này đọc schema đó và SINH RA FORM. Nghĩa là:
 *
 *   Thêm loại chính sách mới (BHXH, ngưỡng duyệt, công thức lương…)
 *     = thêm một JSON Schema
 *     = KHÔNG viết form mới
 *
 * Nếu không có component này, mỗi loại chính sách cần một màn hình riêng, và
 * "sửa luật trên giao diện" sẽ chỉ đúng cho những loại đã được code sẵn — tức
 * là vẫn phải nhờ lập trình viên. Đúng cái vòng lặp ta muốn thoát ra.
 *
 * Hỗ trợ: string, integer, number, boolean, object lồng nhau, và
 * array-of-object (dùng cho bảng bậc thuế — thêm/xoá/sắp xếp dòng).
 */

import { inputCls, Button } from './ui';

// ---------------------------------------------------------------------------
// Kiểu JSON Schema (chỉ những phần ta thật sự dùng)
// ---------------------------------------------------------------------------

export interface JsonSchema {
  type?: string | string[];
  title?: string;
  description?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  minItems?: number;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

const fmtVnd = (n: number) => n.toLocaleString('vi-VN');

function isMoney(key: string, s: JsonSchema): boolean {
  // Heuristic: trường số nguyên có tên gợi tiền tệ thì hiển thị định dạng VND
  const t = s.type;
  const isInt = t === 'integer' || (Array.isArray(t) && t.includes('integer'));
  return isInt && /(deduction|cap|amount|salary|wage|upto|quick)/i.test(key);
}

function typeOf(s: JsonSchema): string {
  if (Array.isArray(s.type)) return s.type.find((t) => t !== 'null') ?? 'string';
  return s.type ?? 'string';
}

// ---------------------------------------------------------------------------
// MỘT TRƯỜNG
// ---------------------------------------------------------------------------

function ScalarField({
  fieldKey,
  schema,
  value,
  required,
  onChange,
  path,
}: {
  fieldKey: string;
  schema: JsonSchema;
  value: Json;
  required: boolean;
  onChange: (v: Json) => void;
  path: string;
}) {
  const t = typeOf(schema);
  const money = isMoney(fieldKey, schema);

  if (t === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
          className="h-4 w-4 accent-[var(--accent)]"
        />
        {schema.title ?? fieldKey}
      </label>
    );
  }

  if (schema.enum) {
    return (
      <select
        className={inputCls}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      >
        {schema.enum.map((o) => (
          <option key={String(o)} value={String(o)}>
            {String(o)}
          </option>
        ))}
      </select>
    );
  }

  if (t === 'integer' || t === 'number') {
    const allowsNull = Array.isArray(schema.type) && schema.type.includes('null');
    return (
      <div>
        <input
          type="number"
          step={t === 'number' ? '0.0001' : '1'}
          min={schema.minimum}
          max={schema.maximum}
          className={`${inputCls} num`}
          value={value === null || value === undefined ? '' : String(value)}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') return onChange(allowsNull ? null : 0);
            const n = t === 'integer' ? parseInt(raw, 10) : parseFloat(raw);
            onChange(Number.isNaN(n) ? 0 : n);
          }}
        />
        {money && typeof value === 'number' && (
          <div className="mt-1 text-right text-[11px] text-[var(--muted)] num">
            {fmtVnd(value)} ₫
          </div>
        )}
        {allowsNull && (
          <button
            type="button"
            onClick={() => onChange(null)}
            className="mt-1 text-[11px] text-[var(--muted)] underline hover:text-[var(--text)]"
          >
            đặt thành "không giới hạn"
          </button>
        )}
      </div>
    );
  }

  // string
  const long = (schema.maxLength ?? 0) > 120 || /basis|note|description/i.test(fieldKey);
  if (long) {
    return (
      <textarea
        rows={2}
        maxLength={schema.maxLength}
        className={inputCls}
        value={String(value ?? '')}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }
  return (
    <input
      type="text"
      maxLength={schema.maxLength}
      className={inputCls}
      value={String(value ?? '')}
      onChange={(e) => onChange(e.target.value)}
      placeholder={required ? '' : '(tuỳ chọn)'}
    />
  );
}

// ---------------------------------------------------------------------------
// OBJECT — đệ quy
// ---------------------------------------------------------------------------

export function SchemaForm({
  schema,
  value,
  onChange,
  errors = {},
}: {
  schema: JsonSchema;
  value: Record<string, Json>;
  onChange: (v: Record<string, Json>) => void;
  errors?: Record<string, string>;
}) {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  const set = (k: string, v: Json) => onChange({ ...value, [k]: v });

  return (
    <div className="space-y-5">
      {Object.entries(props).map(([key, sub]) => {
        const label = sub.title ?? key;
        const err = errors[key];
        const v = value[key];

        // --- MẢNG OBJECT: bảng có thêm/xoá dòng (vd: bậc thuế) -------------
        if (typeOf(sub) === 'array' && sub.items?.properties) {
          const rows = (Array.isArray(v) ? v : []) as Record<string, Json>[];
          const itemProps = sub.items.properties;
          const cols = Object.entries(itemProps);

          return (
            <div key={key} className="rounded-md border border-[var(--border)]">
              <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--panel-2)] px-4 py-2.5">
                <div>
                  <span className="text-sm font-medium">{label}</span>
                  {sub.minItems !== undefined && (
                    <span className="ml-2 text-xs text-[var(--muted)]">
                      tối thiểu {sub.minItems} dòng
                    </span>
                  )}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    const blank: Record<string, Json> = {};
                    for (const [ck, cs] of cols) {
                      const ct = typeOf(cs);
                      blank[ck] = ct === 'integer' || ct === 'number' ? 0 : '';
                    }
                    set(key, [...rows, blank] as unknown as Json);
                  }}
                >
                  + Thêm dòng
                </Button>
              </div>

              {rows.length === 0 ? (
                <p className="px-4 py-6 text-center text-sm text-[var(--muted)]">
                  Chưa có dòng nào
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                        <th className="px-4 py-2 w-10">#</th>
                        {cols.map(([ck, cs]) => (
                          <th key={ck} className="px-3 py-2">
                            {cs.title ?? ck}
                          </th>
                        ))}
                        <th className="px-3 py-2 w-24" />
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, i) => (
                        <tr key={i} className="border-b border-[var(--border)] last:border-0">
                          <td className="px-4 py-2 text-[var(--muted)] num">{i + 1}</td>
                          {cols.map(([ck, cs]) => (
                            <td key={ck} className="px-3 py-2 align-top">
                              <ScalarField
                                fieldKey={ck}
                                schema={cs}
                                value={row[ck] ?? null}
                                required
                                path={`${key}[${i}].${ck}`}
                                onChange={(nv) => {
                                  const next = rows.map((r, j) =>
                                    j === i ? { ...r, [ck]: nv } : r,
                                  );
                                  set(key, next as unknown as Json);
                                }}
                              />
                            </td>
                          ))}
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => set(key, rows.filter((_, j) => j !== i) as unknown as Json)}
                              className="text-xs text-[var(--danger)] hover:underline"
                            >
                              Xoá
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {sub.description && (
                <p className="border-t border-[var(--border)] px-4 py-2 text-xs text-[var(--muted)]">
                  {sub.description}
                </p>
              )}
            </div>
          );
        }

        // --- OBJECT LỒNG NHAU ----------------------------------------------
        if (typeOf(sub) === 'object' && sub.properties) {
          return (
            <fieldset key={key} className="rounded-md border border-[var(--border)] p-4">
              <legend className="px-2 text-sm font-medium">{label}</legend>
              <SchemaForm
                schema={sub}
                value={(v as Record<string, Json>) ?? {}}
                onChange={(nv) => set(key, nv as Json)}
              />
            </fieldset>
          );
        }

        // --- TRƯỜNG ĐƠN ------------------------------------------------------
        return (
          <div key={key}>
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className="text-sm font-medium">
                {label}
                {required.has(key) && <span className="ml-1 text-[var(--danger)]">*</span>}
              </label>
              {moneyHint(key, sub) && typeof v === 'number' && (
                <span className="text-xs text-[var(--muted)] num">{fmtVnd(v)} ₫</span>
              )}
            </div>
            <ScalarField
              fieldKey={key}
              schema={sub}
              value={v ?? null}
              required={required.has(key)}
              path={key}
              onChange={(nv) => set(key, nv)}
            />
            {sub.description && (
              <p className="mt-1 text-xs text-[var(--muted)]">{sub.description}</p>
            )}
            {err && <p className="mt-1 text-xs text-[var(--danger)]">{err}</p>}
          </div>
        );
      })}
    </div>
  );
}

function moneyHint(key: string, s: JsonSchema): boolean {
  return isMoney(key, s);
}

/**
 * Sinh giá trị khởi tạo từ schema — để form mở ra đã có sẵn cấu trúc đúng,
 * người dùng không phải tự dựng object rỗng.
 */
export function defaultsFromSchema(schema: JsonSchema): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const [k, s] of Object.entries(schema.properties ?? {})) {
    const t = typeOf(s);
    if (t === 'array') out[k] = [];
    else if (t === 'object') out[k] = defaultsFromSchema(s);
    else if (t === 'integer' || t === 'number') out[k] = s.minimum ?? 0;
    else if (t === 'boolean') out[k] = false;
    else out[k] = '';
  }
  return out;
}

// ---------------------------------------------------------------------------
// VALIDATE PHÍA CLIENT — chặn submit trước khi gọi API
// ---------------------------------------------------------------------------

export interface SchemaIssue {
  path: (string | number)[];
  message: string;
}

/**
 * Trường có `type: ['integer', 'null']` (như `upto` của bậc thuế cao nhất)
 * thì `null` là MỘT GIÁ TRỊ HỢP LỆ — nghĩa là "không chặn trên", không phải
 * "người dùng quên điền". Coi null là trống sẽ bắt người dùng nhập một con số
 * vô nghĩa cho bậc cuối, và nếu họ nhập đại thì biểu thuế sai.
 */
const isMissing = (v: unknown, s: JsonSchema) => {
  const allowsNull = Array.isArray(s.type) && s.type.includes('null');
  if (v === undefined || v === '') return true;
  return v === null && !allowsNull;
};

/**
 * Kiểm tra giá trị form theo đúng JSON Schema.
 *
 * TẠI SAO CẦN, dù backend đã validate bằng Zod:
 *   Trường số để trống được gửi lên là 0 (xem ScalarField, dòng xử lý
 *   `raw === ''`), và Zod chấp nhận 0 vì các trường tiền có minimum = 0.
 *   Nghĩa là bỏ trống "Trần miễn thuế ăn giữa ca" sẽ LƯU ĐƯỢC thành 0đ,
 *   người lao động bị đánh thuế oan trên tiền ăn ca, và không một dòng log
 *   nào báo. Backend không thể phân biệt "cố ý đặt 0" với "quên điền",
 *   chỉ có form mới biết. Đó là lý do tầng này tồn tại.
 *
 *   Lợi ích phụ: người dùng thấy sai ở trường nào ngay, không đợi round-trip.
 *
 * Đây KHÔNG thay thế Zod — backend vẫn là chốt chặn cuối. Hai tầng dùng chung
 * MỘT JSON Schema nên cấu trúc không thể lệch nhau.
 */
export function validateAgainstSchema(
  schema: JsonSchema,
  value: Record<string, unknown> | null | undefined,
  at: (string | number)[] = [],
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const required = new Set(schema.required ?? []);
  const obj = (value ?? {}) as Record<string, unknown>;

  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const v = obj[key];
    const path = [...at, key];
    const t = typeOf(sub);

    if (required.has(key) && isMissing(v, sub)) {
      issues.push({ path, message: 'Bắt buộc điền.' });
      continue;
    }
    // Không có giá trị để kiểm tra tiếp. Riêng null: nếu schema cho phép null
    // thì đó là giá trị hợp lệ (vd. upto của bậc cuối), nếu không cho phép
    // thì đã bị chặn ở bước required hoặc sẽ bị chặn ở bước kiểm kiểu dưới.
    if (v === null || v === undefined || v === '') continue;

    if (t === 'array') {
      const arr = Array.isArray(v) ? v : [];
      const minItems = sub.minItems ?? (required.has(key) ? 1 : 0);
      if (arr.length < minItems) {
        issues.push({ path, message: `Cần ít nhất ${minItems} dòng.` });
      }
      if (sub.items) {
        arr.forEach((row, i) => {
          issues.push(
            ...validateAgainstSchema(sub.items as JsonSchema, row as Record<string, unknown>, [
              ...path,
              i,
            ]),
          );
        });
      }
      continue;
    }

    if (t === 'object') {
      issues.push(...validateAgainstSchema(sub, v as Record<string, unknown>, path));
      continue;
    }

    if (t === 'integer' || t === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({ path, message: 'Phải là một số hợp lệ.' });
        continue;
      }
      if (t === 'integer' && !Number.isInteger(v)) {
        issues.push({ path, message: 'Phải là số nguyên (VND không có số lẻ).' });
      }
      if (typeof sub.minimum === 'number' && v < sub.minimum) {
        issues.push({ path, message: `Không được nhỏ hơn ${fmtVnd(sub.minimum)}.` });
      }
      if (typeof sub.maximum === 'number' && v > sub.maximum) {
        issues.push({ path, message: `Không được lớn hơn ${fmtVnd(sub.maximum)}.` });
      }
      continue;
    }

    // string / enum
    if (typeof v !== 'string') {
      issues.push({ path, message: 'Phải là chuỗi.' });
      continue;
    }
    if (typeof sub.maxLength === 'number' && v.length > sub.maxLength) {
      issues.push({ path, message: `Tối đa ${sub.maxLength} ký tự.` });
    }
    if (typeof sub.minLength === 'number' && v.length < sub.minLength) {
      issues.push({ path, message: `Tối thiểu ${sub.minLength} ký tự.` });
    }
    if (Array.isArray(sub.enum) && !sub.enum.includes(v)) {
      issues.push({ path, message: 'Giá trị không nằm trong danh sách cho phép.' });
    }
  }
  return issues;
}
