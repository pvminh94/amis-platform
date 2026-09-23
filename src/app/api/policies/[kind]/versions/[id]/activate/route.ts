import { NextResponse } from 'next/server';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { getDb } from '@/db/client';
import { activateVersion, PolicyError } from '@/policy/registry';

export const dynamic = 'force-dynamic';

export async function POST(req: Request, ctx: { params: Promise<{ kind: string; id: string }> }) {
  try {
    await requirePermission(req, 'policy:activate');
  } catch (e) {
    return authErrorResponse(e);
  }

  const { id } = await ctx.params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await activateVersion(
      id,
      {
        id: String(body.actor ?? 'web-user'),
        ip: req.headers.get('x-forwarded-for') ?? null,
        reason: body.reason ? String(body.reason) : null,
      },
      getDb(),
    );
    return NextResponse.json({ data: result });
  } catch (e) {
    if (e instanceof PolicyError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message, details: e.details } },
        { status: 400 },
      );
    }
    console.error('[api/.../activate]', e);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : 'Lỗi không xác định' } },
      { status: 500 },
    );
  }
}
