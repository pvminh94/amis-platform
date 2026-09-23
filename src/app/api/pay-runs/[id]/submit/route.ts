/** /api/pay-runs/[id]/submit — nộp một kỳ lương ra duyệt. */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { submitPayRunForApproval } from '@/lib/approval';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { isUuid } from '@/lib/uuid';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  let principal;
  try {
    principal = await requirePermission(req, 'payroll:submit');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;
  // PostgreSQL ném 22P02 trước khi notFound() kịp chạy nếu đây không phải UUID.
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Mã kỳ lương không hợp lệ' } },
      { status: 400 },
    );
  }

  try {
    // Người nộp lấy từ token, không từ body do client tự khai.
    const r = await submitPayRunForApproval(id, principal.claims.username, undefined, getDb());
    return NextResponse.json({
      requestId: r.requestId,
      chain: r.chain.map((c) => c.name),
    });
  } catch (e) {
    return NextResponse.json(
      { error: { code: 'SUBMIT_FAILED', message: e instanceof Error ? e.message : String(e) } },
      { status: 409 },
    );
  }
}
