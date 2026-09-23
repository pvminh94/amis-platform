/**
 * /api/approvals/[id] — thực hiện một hành động duyệt.
 *
 * POST { action: 'APPROVE' | 'REJECT' | ..., comment?, actorId }
 *
 * Chưa có xác thực thật (Phase 2 chưa làm auth), nên actorId đến từ body. Khi
 * có JWT thì phải lấy từ token — KHÔNG BAO GIỜ tin actorId do client gửi, vì
 * ai cũng gửi được actorId của CEO. Ghi chú này ở đây để người làm auth sau
 * không bỏ sót.
 */

import { NextResponse } from 'next/server';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { approvalRequests } from '@/db/schema';
import { actOnApproval, syncPayRunStatus } from '@/lib/approval';
import { extractClientIp, WORKFLOW_ACTIONS, type WorkflowAction } from '@/engine/workflow';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(req, 'approval:act');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;

  let body: { action?: string; comment?: string; actorId?: string; actorRole?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_JSON', message: 'Body không phải JSON hợp lệ.' } },
      { status: 400 },
    );
  }

  const action = body.action as WorkflowAction;
  if (!WORKFLOW_ACTIONS.includes(action)) {
    return NextResponse.json(
      {
        error: {
          code: 'UNKNOWN_ACTION',
          message: `Hành động '${String(body.action)}' không tồn tại. Có: ${WORKFLOW_ACTIONS.join(', ')}.`,
        },
      },
      { status: 400 },
    );
  }

  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'BAD_ID', message: `'${id}' không phải là một định danh hợp lệ.` } },
      { status: 404 },
    );
  }

  const db = getDb();
  const [reqRow] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  if (!reqRow) {
    return NextResponse.json(
      { error: { code: 'NOT_FOUND', message: `Không tìm thấy đơn duyệt ${id}.` } },
      { status: 404 },
    );
  }

  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  try {
    const result = await actOnApproval({
      requestId: id,
      action,
      actorId: body.actorId ?? null,
      actorName: body.actorId ?? null,
      actorRole: body.actorRole ?? null,
      comment: body.comment ?? null,
      ipAddress: extractClientIp(headers),
      userAgent: headers['user-agent'] ?? null,
    });

    // Kỳ lương phải đổi trạng thái theo đơn — nhưng chỉ sau khi duyệt thành công.
    if (reqRow.docType === 'PAYRUN') {
      await syncPayRunStatus(reqRow.docRef, result.state);
    }

    return NextResponse.json({
      requestId: id,
      state: result.state,
      currentStep: result.currentStep,
      finished: result.finished,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: {
          code: e instanceof Error && 'code' in e ? String((e as { code: unknown }).code) : 'REJECTED',
          message: e instanceof Error ? e.message : String(e),
        },
      },
      { status: 409 },
    );
  }
}
