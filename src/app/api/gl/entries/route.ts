/** GET /api/gl/entries?year=2026&month=9 — các bút toán đã ghi, kèm dòng. */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { entriesForPeriod } from '@/lib/gl';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'gl:read');
  } catch (e) {
    return authErrorResponse(e);
  }

  const url = new URL(req.url);
  const year = Number(url.searchParams.get('year'));
  const month = Number(url.searchParams.get('month'));

  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return NextResponse.json(
      { error: { code: 'INVALID_PERIOD', message: 'Cần year và month (1–12) hợp lệ' } },
      { status: 400 },
    );
  }

  const entries = await entriesForPeriod(year, month, getDb());
  return NextResponse.json({ period: `${String(month).padStart(2, '0')}/${year}`, entries });
}
