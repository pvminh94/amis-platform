/** /api/pay-runs/[id]/submit — nộp một kỳ lương ra duyệt. */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { submitPayRunForApproval } from '@/lib/approval';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { actorId?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* body rỗng thì dùng mặc định */
  }

  try {
    const r = await submitPayRunForApproval(id, body.actorId ?? 'anonymous', undefined, getDb());
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
