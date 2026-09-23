import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { policyAuditLogs, policyKinds, policyVersions } from '@/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const { kind } = await ctx.params;
  try {
    const db = getDb();
    const kinds = await db.select().from(policyKinds).where(eq(policyKinds.code, kind)).limit(1);
    const kindRow = kinds[0];
    if (!kindRow) {
      return NextResponse.json({ error: { code: 'NOT_FOUND', message: `Không có loại '${kind}'` } }, { status: 404 });
    }
    const versions = await db
      .select()
      .from(policyVersions)
      .where(eq(policyVersions.kindCode, kind))
      .orderBy(desc(policyVersions.version));
    const audit = await db
      .select()
      .from(policyAuditLogs)
      .where(eq(policyAuditLogs.kindCode, kind))
      .orderBy(desc(policyAuditLogs.at))
      .limit(20);
    return NextResponse.json({ kind: kindRow, versions, audit });
  } catch (e) {
    console.error('[api/policies/[kind]]', e);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : 'Lỗi không xác định' } },
      { status: 500 },
    );
  }
}
