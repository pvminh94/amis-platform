import { NextResponse } from 'next/server';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { policyKinds, policyVersions } from '@/db/schema';

export const dynamic = 'force-dynamic';

/** Danh sách loại chính sách + phiên bản đang hiệu lực của mỗi loại. */
export async function GET(req: Request) {
  try {
    await requirePermission(req, 'policy:read');
  } catch (e) {
    return authErrorResponse(e);
  }

  try {
    const db = getDb();
    const kinds = await db.select().from(policyKinds);

    const withActive = await Promise.all(
      kinds.map(async (k) => {
        const rows = await db
          .select({
            version: policyVersions.version,
            status: policyVersions.status,
            effectiveFrom: policyVersions.effectiveFrom,
            effectiveTo: policyVersions.effectiveTo,
          })
          .from(policyVersions)
          .where(eq(policyVersions.kindCode, k.code))
          .orderBy(desc(policyVersions.version));
        return { ...k, versions: rows };
      }),
    );

    return NextResponse.json({ data: withActive });
  } catch (e) {
    console.error('[api/policies]', e);
    return NextResponse.json(
      { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : 'Lỗi không xác định' } },
      { status: 500 },
    );
  }
}
