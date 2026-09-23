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
    const r = await postPayRun(id, { id: body.actorId ?? 'anonymous' }, getDb());
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
