/**
 * POST /api/payment-batches/[id]/status — chuyển trạng thái lô.
 *
 * GENERATED → SENT → RETURNED, và mọi trạng thái (trừ VOID) → VOID.
 * Máy trạng thái nằm trong `updateBatchStatus`, không nằm ở đây: nếu route tự
 * kiểm tra thì thêm một chỗ thứ hai phát biểu cùng một luật, và hai chỗ sẽ lệch.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getDb } from '@/db/client';
import { PaymentFileError } from '@/engine/payment-file';
import { updateBatchStatus } from '@/lib/payment';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({
  status: z.enum(['SENT', 'RETURNED', 'VOID']),
  returnedCount: z.number().int().min(0).optional(),
  notes: z.string().trim().max(500).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let _principal;
  try {
    // Đổi trạng thái lô = quyết định đã gửi tiền hay chưa, nên đòi quyền xuất.
    _principal = await requirePermission(req, 'payment:export');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Mã lô không hợp lệ' } },
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

  try {
    await updateBatchStatus(getDb(), id, parsed.data.status, {
      returnedCount: parsed.data.returnedCount,
      notes: parsed.data.notes,
    });
    return NextResponse.json({ ok: true, status: parsed.data.status });
  } catch (e) {
    const code = e instanceof PaymentFileError ? e.code : 'UPDATE_FAILED';
    return NextResponse.json(
      { error: { code, message: e instanceof Error ? e.message : String(e) } },
      // Bước chuyển không hợp lệ là xung đột trạng thái, không phải lỗi dữ liệu.
      { status: code === 'INVALID_PAYMENT_DATA' ? 409 : 500 },
    );
  }
}
