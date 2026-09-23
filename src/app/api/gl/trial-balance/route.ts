/**
 * GET /api/gl/trial-balance?year=2026&month=9 — bảng đối chiếu thử.
 *
 * Không có tham số thì trả toàn bộ sổ. Tổng nợ phải bằng tổng có; trường
 * `balanced` nói lên điều đó để giao diện không phải tự tính lại.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { trialBalance } from '@/lib/gl';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const year = url.searchParams.get('year');
  const month = url.searchParams.get('month');

  const filter: { periodYear?: number; periodMonth?: number } = {};
  if (year !== null) {
    const n = Number(year);
    if (!Number.isInteger(n) || n < 1900 || n > 9999) {
      return NextResponse.json(
        { error: { code: 'INVALID_YEAR', message: 'Năm không hợp lệ' } },
        { status: 400 },
      );
    }
    filter.periodYear = n;
  }
  if (month !== null) {
    const n = Number(month);
    // Tháng chỉ có nghĩa khi đã có năm — lọc tháng một mình sẽ gộp các tháng
    // Chín của nhiều năm lại với nhau mà không ai biết.
    if (!Number.isInteger(n) || n < 1 || n > 12 || year === null) {
      return NextResponse.json(
        { error: { code: 'INVALID_MONTH', message: 'Tháng phải đi kèm năm và nằm trong 1–12' } },
        { status: 400 },
      );
    }
    filter.periodMonth = n;
  }

  const tb = await trialBalance(filter, getDb());
  return NextResponse.json(tb);
}
