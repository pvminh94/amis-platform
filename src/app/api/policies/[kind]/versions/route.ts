import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { createVersion, PolicyError } from '@/policy/registry';
import { vnPitParamsSchema, vnPitJsonSchema } from '@/policy/tax-params';
import { vnSiParamsSchema, vnSiJsonSchema } from '@/policy/si-params';
import { vnSalaryParamsSchema, vnSalaryJsonSchema } from '@/policy/salary-params';
import { approvalParamsSchema, approvalJsonSchema } from '@/policy/approval-params';
import { printParamsSchema, printJsonSchema } from '@/policy/print-params';
import { reportParamsSchema, reportJsonSchema } from '@/policy/report-params';
import { glMapParamsSchema, glMapJsonSchema } from '@/policy/gl-params';
import { shiftParamsSchema, shiftJsonSchema } from '@/policy/shift-params';
import { rotationParamsSchema, rotationJsonSchema } from '@/policy/rotation-params';
import { bankPayoutParamsSchema, bankPayoutJsonSchema } from '@/policy/bank-params';
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
  {
    nameVi: string;
    schema: unknown;
    json: Record<string, unknown>;
    /**
     * Nhiều thực thể cùng loại được ACTIVE đồng thời hay không.
     *
     * Khai ở đây để route tạo kind đúng ngay lần đầu — route là nơi ĐẦU TIÊN một
     * loại có thể được tạo ra (người dùng bấm "tạo phiên bản" trước khi chạy
     * seed), nên nếu nó không biết cờ này thì kind sinh ra sẽ sai.
     */
    exclusiveByCode: boolean;
  }
> = {
  VN_PIT: {
    nameVi: 'Thuế thu nhập cá nhân Việt Nam',
    schema: vnPitParamsSchema,
    json: vnPitJsonSchema,
     exclusiveByCode: false,
  },
  TEST_PIT: {
    nameVi: 'Thuế TNCN (bản dùng cho test)',
    schema: vnPitParamsSchema,
    json: vnPitJsonSchema,
     exclusiveByCode: false,
  },
  // ↓↓↓ MỘT DÒNG NÀY là tất cả những gì tầng API cần cho một loại chính sách
  //     mới. Giao diện /policies/VN_BHXH/new tự sinh form từ vnSiJsonSchema.
  VN_BHXH: {
    nameVi: 'Bảo hiểm xã hội Việt Nam',
    schema: vnSiParamsSchema,
    json: vnSiJsonSchema,
    exclusiveByCode: false,
  },
  VN_SALARY: {
    nameVi: 'Công thức lương',
    schema: vnSalaryParamsSchema,
    json: vnSalaryJsonSchema,
    exclusiveByCode: false,
  },
  APPROVAL: {
    nameVi: 'Ngưỡng duyệt',
    schema: approvalParamsSchema,
    json: approvalJsonSchema,
    exclusiveByCode: false,
  },
  PRINT: {
    nameVi: 'Mẫu in',
    schema: printParamsSchema,
    json: printJsonSchema,
    exclusiveByCode: true,
  },
  // ↓↓↓ Vẫn chỉ MỘT DÒNG cho loại thứ sáu. Không có trang /reports nào được
  //     viết riêng cho LUONG_THEO_BO_PHAN — form sinh từ reportJsonSchema.
  REPORT_DEF: {
    nameVi: 'Định nghĩa báo cáo',
    schema: reportParamsSchema,
    json: reportJsonSchema,
    exclusiveByCode: true,
  },
  GL_MAP: {
    nameVi: 'Định khoản lương vào sổ cái',
    schema: glMapParamsSchema,
    json: glMapJsonSchema,
     exclusiveByCode: false,
  },
  SHIFT: {
    nameVi: 'Định nghĩa ca làm việc',
    schema: shiftParamsSchema,
    json: shiftJsonSchema,
    exclusiveByCode: true,
  },
  // Loại thứ MƯỜI. Vẫn chỉ một dòng: không có trang nào được viết riêng cho
  // ROT_3CA4KIP — form sinh từ rotationJsonSchema, validate bằng đúng bộ luật
  // của engine (validateRotation).
  SHIFT_ROTATION: {
    nameVi: 'Hệ xoay ca',
    schema: rotationParamsSchema,
    json: rotationJsonSchema,
    exclusiveByCode: true,
  },
  // Loại thứ MƯỜI MỘT. Vẫn một dòng: không có trang nào viết riêng cho BANK_VCB.
  BANK_PAYOUT: {
    nameVi: 'Tham số thanh toán ngân hàng',
    schema: bankPayoutParamsSchema,
    json: bankPayoutJsonSchema,
    exclusiveByCode: true,
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
