/**
 * POST /api/pay-runs/[id]/post-gl — ghi sổ một kỳ lương.
 *
 * Lỗi ở đây được dịch sang mã HTTP theo BẢN CHẤT của lỗi, không phải một mã
 * chung chung: ghi trùng là xung đột (409), không có phiếu là không tìm thấy
 * (404), còn sổ không cân là dữ liệu không hợp lệ (422). Người gọi phân biệt
 * được "thử lại cũng vô ích" với "sửa dữ liệu rồi thử lại".
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { GlError, postPayRun } from '@/lib/gl';
import { isUuid } from '@/lib/uuid';
import { PolicyError } from '@/policy/registry';
import { authErrorResponse, requirePermission } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = {
  ALREADY_POSTED: 409,
  NO_PAYSLIPS: 404,
  NOT_RESOLVABLE: 409,
  UNBALANCED: 422,
  SINGLE_SIDED: 422,
  NEGATIVE_AMOUNT: 422,
  NOT_A_NUMBER: 422,
  MISSING_SI_BREAKDOWN: 422,
  MISSING_ACCOUNT: 422,
  SI_BREAKDOWN_MISMATCH: 422,
};

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Ghi sổ là thao tác kế toán có hệ quả: đòi quyền riêng, và quyền được tra từ
  // DB tại thời điểm này chứ không lấy từ token — người vừa bị cắt quyền phải
  // mất nó ngay, không phải 15 phút sau khi token hết hạn.
  let principal;
  try {
    principal = await requirePermission(req, 'gl:post');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;
  let body: { actorId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* body rỗng thì dùng mặc định */
  }

  // PostgreSQL sẽ tự ném 22P02 nếu đưa chuỗi không phải UUID vào cột uuid, và
  // lỗi đó ra tới người dùng thành 500. Chặn trước ở đây.
  if (!isUuid(id)) {
    return NextResponse.json(
      { error: { code: 'INVALID_ID', message: 'Mã kỳ lương không hợp lệ' } },
      { status: 400 },
    );
  }

  try {
    // Ghi ai đã ghi sổ theo DANH TÍNH THẬT từ token, không theo actorId client
    // tự khai — trường "người ghi" mà client đặt được thì vô nghĩa khi truy cứu.
    const r = await postPayRun(id, { id: principal.claims.sub }, getDb());
    return NextResponse.json({
      periodLabel: r.periodLabel,
      entries: r.entries.map((e) => ({
        entryNo: e.entryNo,
        entryType: e.entryType,
        totalDebit: e.totalDebit,
        totalCredit: e.totalCredit,
        lineCount: e.lines.length,
      })),
    });
  } catch (e) {
    const code = e instanceof GlError || e instanceof PolicyError ? e.code : 'POSTING_FAILED';
    return NextResponse.json(
      { error: { code, message: e instanceof Error ? e.message : String(e) } },
      { status: STATUS[code] ?? 500 },
    );
  }
}
