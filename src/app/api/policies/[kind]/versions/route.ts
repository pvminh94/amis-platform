import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createVersion, PolicyError } from '@/policy/registry';
import { vnPitParamsSchema, vnPitJsonSchema } from '@/policy/tax-params';
import { ensureKind } from '@/policy/registry';

export const dynamic = 'force-dynamic';

/**
 * Bảng tra loại chính sách → validator.
 *
 * Đây là chỗ DUY NHẤT cần thêm code khi có loại chính sách mới: một dòng.
 * Form trên UI thì tự sinh từ JSON Schema, không phải viết.
 */
const VALIDATORS: Record<string, { schema: unknown; json: Record<string, unknown> }> = {
  VN_PIT: { schema: vnPitParamsSchema, json: vnPitJsonSchema },
  TEST_PIT: { schema: vnPitParamsSchema, json: vnPitJsonSchema },
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
        nameVi: kind === 'VN_PIT' ? 'Thuế thu nhập cá nhân Việt Nam' : kind,
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
