/**
 * POST /api/pay-runs/[id]/payment-file — xuất một lô thanh toán ngân hàng.
 *
 * ⚠️ VỀ QUYỀN: `payment:export` thuộc KẾ TOÁN, không thuộc NHÂN SỰ. Người tính
 * lương không phải người chuyển tiền — nếu một tài khoản làm được cả hai thì nó
 * tự tăng lương cho mình rồi tự chuyển. Cùng nguyên tắc tách nhiệm vụ đã áp dụng
 * cho gl:post và payroll:run.
 *
 * KHÔNG sinh lại nếu kỳ này đã có lô chưa VOID: ràng buộc `uq_bank_batches_one_active`
 * chặn ở tầng CSDL và đó là chủ ý. Một kỳ lương chỉ được có MỘT file gửi ngân
 * hàng; muốn xuất lại thì phải VOID lô cũ, và việc VOID có để lại dấu vết.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';

import { getDb } from '@/db/client';
import { payRuns } from '@/db/schema';
import { PaymentFileError } from '@/engine/payment-file';
import { createPaymentBatch } from '@/lib/payment';
import { PolicyError } from '@/policy/registry';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  regimeCode: z.string().trim().min(1, 'regimeCode bắt buộc'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date phải theo YYYY-MM-DD')
    .optional(),
});

const STATUS: Record<string, number> = {
  INVALID_PAYMENT_DATA: 422,
  EMPTY_FILE: 422,
  TOTAL_MISMATCH: 500,
  BAD_DATE: 400,
  BAD_BATCH_NO: 500,
  NOT_RESOLVABLE: 409,
  DUPLICATE_BATCH: 409,
};

/** PostgreSQL ném 23505 khi vi phạm ràng buộc một-lô-chưa-VOID. */
function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { code?: string }).code === '23505' &&
    String((e as { constraint?: string }).constraint ?? '') === 'uq_bank_batches_one_active'
  );
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let principal;
  try {
    principal = await requirePermission(req, 'payment:export');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Mã kỳ lương không hợp lệ' } },
      { status: 400 },
    );
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'INVALID_BODY', issues: parsed.error.flatten() } },
      { status: 400 },
    );
  }

  const db = getDb();
  try {
    const [run] = await db.select().from(payRuns).where(eq(payRuns.id, id)).limit(1);
    if (!run) {
      return NextResponse.json(
        { error: { code: 'NOT_FOUND', message: 'Không tìm thấy kỳ lương' } },
        { status: 404 },
      );
    }

    const batch = await createPaymentBatch(db, {
      payRunId: id,
      regimeCode: parsed.data.regimeCode,
      date: parsed.data.date,
      // Ai xuất file lấy theo DANH TÍNH THẬT trong token, không theo client tự khai.
      actor: principal.claims.sub,
    });

    return NextResponse.json(
      {
        batchId: batch.batchId,
        batchNo: batch.batchNo,
        fileName: batch.fileName,
        rowCount: batch.file.rowCount,
        totalAmount: batch.file.totalAmount,
        byteLength: batch.file.byteLength,
        checksum: batch.file.checksum,
        status: 'GENERATED',
        // Ba danh sách này là LÝ DO file có thể thiếu người. Trả về để kế toán
        // đối chiếu trước khi gửi ngân hàng, không bắt họ tự suy ra từ số món.
        missing: batch.missing,
        unverified: batch.unverified,
        warnings: batch.warnings,
      },
      { status: 201 },
    );
  } catch (e) {
    if (isUniqueViolation(e)) {
      return NextResponse.json(
        {
          error: {
            code: 'DUPLICATE_BATCH',
            message: 'Kỳ này đã có lô chưa huỷ. Muốn xuất lại, hãy huỷ (VOID) lô cũ trước.',
          },
        },
        { status: 409 },
      );
    }
    const code =
      e instanceof PaymentFileError || e instanceof PolicyError ? e.code : 'EXPORT_FAILED';
    return NextResponse.json(
      { error: { code, message: e instanceof Error ? e.message : String(e) } },
      { status: STATUS[code] ?? 500 },
    );
  }
}
