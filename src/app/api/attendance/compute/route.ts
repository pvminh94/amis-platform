/**
 * POST /api/attendance/compute — { from, to, employeeCodes?, pairing? }
 *
 * Tính (hoặc tính lại) công ngày cho một khoảng. Idempotent: chạy hai lần với
 * cùng đầu vào cho ra cùng một bộ số, và UNIQUE (nhân viên, ngày) đảm bảo không
 * nhân đôi dòng.
 *
 * Đây là hành động GHI nên tách khỏi route đọc và đòi quyền riêng. Lý do không
 * gộp: một màn hình danh sách mà chỉ cần quyền đọc cũng tính lại được dữ liệu
 * thì bất kỳ ai mở trang cũng có thể ghi, và "xem" không còn là thao tác an toàn.
 */

import { NextResponse } from 'next/server';

import { AttendanceServiceError, computeAttendance } from '@/lib/attendance';
import { getDb } from '@/db/client';
import { authErrorResponse, requirePermission } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

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
  if (typeof b.from !== 'string' || typeof b.to !== 'string') {
    return NextResponse.json(
      { error: { code: 'BAD_RANGE', message: 'Cần from và to dạng chuỗi YYYY-MM-DD' } },
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

  try {
    const summary = await computeAttendance(getDb(), {
      from: b.from,
      to: b.to,
      employeeCodes: b.employeeCodes as string[] | undefined,
    });
    // 200 chứ không phải 201: đây là phép tính lại dữ liệu dẫn xuất, không phải
    // tạo một tài nguyên mới. Chạy lại lần hai vẫn trả 200 với cùng nội dung.
    return NextResponse.json(summary);
  } catch (e) {
    if (e instanceof AttendanceServiceError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message } },
        { status: e.code === 'BAD_RANGE' ? 400 : 422 },
      );
    }
    throw e;
  }
}
