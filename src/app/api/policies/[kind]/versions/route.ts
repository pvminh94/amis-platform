import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createVersion, PolicyError } from '@/policy/registry';
import { vnPitParamsSchema, vnPitJsonSchema } from '@/policy/tax-params';
import { vnSiParamsSchema, vnSiJsonSchema } from '@/policy/si-params';
import { vnSalaryParamsSchema, vnSalaryJsonSchema } from '@/policy/salary-params';
import { ensureKind } from '@/policy/registry';

export const dynamic = 'force-dynamic';

/**
 * Bảng tra loại chính sách → validator.
 *
 * Đây là chỗ DUY NHẤT cần thêm code khi có loại chính sách mới: MỘT DÒNG.
 * Form trên UI thì tự sinh từ JSON Schema, không phải viết.
 *
 * `nameVi` nằm trong map chứ không phải một lệnh ba ngôi ở dưới: trước đây thêm
 * một loại phải sửa HAI chỗ, và chỗ thứ hai rất dễ quên — quên thì tên loại
 * chính sách hiển thị trên giao diện là mã thô "VN_BHXH".
 */
const VALIDATORS: Record<
  string,
  { nameVi: string; schema: unknown; json: Record<string, unknown> }
> = {
  VN_PIT: {
    nameVi: 'Thuế thu nhập cá nhân Việt Nam',
    schema: vnPitParamsSchema,
    json: vnPitJsonSchema,
  },
  TEST_PIT: {
    nameVi: 'Thuế TNCN (bản dùng cho test)',
    schema: vnPitParamsSchema,
    json: vnPitJsonSchema,
  },
  // ↓↓↓ MỘT DÒNG NÀY là tất cả những gì tầng API cần cho một loại chính sách
  //     mới. Giao diện /policies/VN_BHXH/new tự sinh form từ vnSiJsonSchema.
  VN_BHXH: {
    nameVi: 'Bảo hiểm xã hội Việt Nam',
    schema: vnSiParamsSchema,
    json: vnSiJsonSchema,
  },
  VN_SALARY: {
    nameVi: 'Công thức lương',
    schema: vnSalaryParamsSchema,
    json: vnSalaryJsonSchema,
  },
};

export async function POST(req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  const entry = VALIDATORS[kind];
  if (!entry) {
    return NextResponse.json(
      { error: { code: 'NO_VALIDATOR', message: `Chưa đăng ký validator cho loại '${kind}'` } },
      { status: 400 },
    );
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const db = getDb();

    // Đảm bảo kind tồn tại (idempotent)
    await ensureKind(
      {
        code: kind,
        nameVi: entry.nameVi,
        paramsSchema: entry.json,
      },
      db,
    );

    const result = await createVersion(
      {
        kindCode: kind,
        effectiveFrom: String(body.effectiveFrom ?? ''),
        effectiveTo: body.effectiveTo ? String(body.effectiveTo) : null,
        legalBasis: body.legalBasis ? String(body.legalBasis) : null,
        note: body.note ? String(body.note) : null,
        createdBy: String(body.actor ?? 'web-user'),
        actorIp: req.headers.get('x-forwarded-for') ?? null,
      },
      body.params,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      entry.schema as any,
      db,
    );

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (e) {
    if (e instanceof PolicyError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message, details: e.details } },
        { status: 400 },
      );
    }
    console.error('[api/policies/[kind]/versions]', e);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : 'Lỗi không xác định' } },
      { status: 500 },
    );
  }
}
