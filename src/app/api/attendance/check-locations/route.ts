/**
 * POST /api/attendance/check-locations — { from, to, employeeCodes? }
 *
 * Kiểm tra vị trí của các quẹt từ thiết bị di động theo hàng rào đang hiệu lực
 * tại NGÀY CỦA QUẸT, rồi ghi kết luận vào raw_punches.geo_status.
 *
 * Idempotent: chạy lại cho cùng một khoảng ngày sẽ đánh giá lại và ghi đè cùng
 * một cột. Chỉ đổi kết quả nếu HÀNG RÀO đổi — và đó là hành vi mong muốn, vì
 * hàng rào là chính sách có khoảng hiệu lực.
 *
 * Dùng quyền `attendance:compute` chứ không đặt quyền mới: đây cùng một lớp hành
 * động với tính lại công (ghi dữ liệu dẫn xuất về chấm công), và tách thành hai
 * quyền thì người vận hành phải nhớ cấp cả hai cho cùng một vai trò.
 */

import { NextResponse } from 'next/server';

import { getDb } from '@/db/client';
import { authErrorResponse, requirePermission } from '@/lib/rbac';
import { validatePunchLocations } from '@/lib/location-check';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function POST(req: Request) {
  try {
    await requirePermission(req, 'attendance:compute');
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_JSON', message: 'Body không phải JSON hợp lệ' } },
      { status: 400 },
    );
  }

  const b = (body ?? {}) as { from?: unknown; to?: unknown; employeeCodes?: unknown };
  if (typeof b.from !== 'string' || typeof b.to !== 'string' || !DATE_RE.test(b.from) || !DATE_RE.test(b.to)) {
    return NextResponse.json(
      { error: { code: 'BAD_RANGE', message: 'Cần from và to dạng YYYY-MM-DD' } },
      { status: 400 },
    );
  }
  if (
    b.employeeCodes !== undefined &&
    (!Array.isArray(b.employeeCodes) || b.employeeCodes.some((c) => typeof c !== 'string'))
  ) {
    return NextResponse.json(
      { error: { code: 'BAD_EMPLOYEES', message: 'employeeCodes phải là mảng chuỗi' } },
      { status: 400 },
    );
  }

  const summary = await validatePunchLocations(getDb(), {
    from: b.from,
    to: b.to,
    employeeCodes: b.employeeCodes as string[] | undefined,
  });
  return NextResponse.json(summary);
}
