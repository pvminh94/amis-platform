/**
 * GET /api/attendance?from=2026-09-01&to=2026-09-30[&employeeCode=NV001][&status=MISSING_PUNCH]
 *
 * Trả công ngày đã tính, kèm tên nhân viên để giao diện không phải join lần nữa.
 *
 * `warnings` và `orphan` được trả kèm có chủ đích: một bảng chấm công chỉ hiện
 * PRESENT/ABSENT thì không dùng được — việc của nhân sự nằm ở những dòng CÓ VẤN
 * ĐỀ, và những dòng đó phải nổi lên ngay trên màn hình đầu tiên.
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';

import { dailyAttendance, employees } from '@/db/schema';
import { getDb } from '@/db/client';
import { authErrorResponse, requirePermission } from '@/lib/rbac';

export const dynamic = 'force-dynamic';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  try {
    await requirePermission(req, 'attendance:read');
  } catch (e) {
    return authErrorResponse(e);
  }

  const url = new URL(req.url);
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const employeeCode = url.searchParams.get('employeeCode');
  const status = url.searchParams.get('status');

  // from/to bắt buộc. Không có khoảng thì truy vấn sẽ quét cả bảng — và với
  // 1.000 nhân viên × 365 ngày là 365.000 dòng trả về một lần.
  if (!from || !to || !DATE_RE.test(from) || !DATE_RE.test(to)) {
    return NextResponse.json(
      { error: { code: 'BAD_RANGE', message: 'Cần from và to theo dạng YYYY-MM-DD' } },
      { status: 400 },
    );
  }
  if (from > to) {
    return NextResponse.json(
      { error: { code: 'BAD_RANGE', message: 'from phải nhỏ hơn hoặc bằng to' } },
      { status: 400 },
    );
  }

  const db = getDb();
  const conds = [gte(dailyAttendance.workDate, from), lte(dailyAttendance.workDate, to)];
  if (employeeCode) conds.push(eq(dailyAttendance.employeeCode, employeeCode));
  if (status) conds.push(eq(dailyAttendance.status, status));

  const rows = await db
    .select({
      employeeCode: dailyAttendance.employeeCode,
      fullName: employees.fullName,
      department: employees.department,
      workDate: dailyAttendance.workDate,
      shiftCode: dailyAttendance.shiftCode,
      dayKind: dailyAttendance.dayKind,
      status: dailyAttendance.status,
      workedMinutes: dailyAttendance.workedMinutes,
      standardDays: dailyAttendance.standardDays,
      nightMinutes: dailyAttendance.nightMinutes,
      lateMinutes: dailyAttendance.lateMinutes,
      earlyLeaveMinutes: dailyAttendance.earlyLeaveMinutes,
      otWeekdayMinutes: dailyAttendance.otWeekdayMinutes,
      otWeekendMinutes: dailyAttendance.otWeekendMinutes,
      otHolidayMinutes: dailyAttendance.otHolidayMinutes,
      otNightMinutes: dailyAttendance.otNightMinutes,
      punchCount: dailyAttendance.punchCount,
      warnings: dailyAttendance.warnings,
    })
    .from(dailyAttendance)
    .leftJoin(employees, eq(employees.employeeCode, dailyAttendance.employeeCode))
    .where(and(...conds))
    .orderBy(dailyAttendance.workDate, dailyAttendance.employeeCode)
    // Giới hạn cứng: một tháng × 1.000 người là 30.000 dòng, đủ cho mọi màn hình.
    .limit(31_000);

  const totals = rows.reduce(
    (a, r) => ({
      workedMinutes: a.workedMinutes + r.workedMinutes,
      nightMinutes: a.nightMinutes + r.nightMinutes,
      otWeekdayMinutes: a.otWeekdayMinutes + r.otWeekdayMinutes,
      otWeekendMinutes: a.otWeekendMinutes + r.otWeekendMinutes,
      otHolidayMinutes: a.otHolidayMinutes + r.otHolidayMinutes,
      otNightMinutes: a.otNightMinutes + r.otNightMinutes,
      standardDays: a.standardDays + Number(r.standardDays),
    }),
    {
      workedMinutes: 0,
      nightMinutes: 0,
      otWeekdayMinutes: 0,
      otWeekendMinutes: 0,
      otHolidayMinutes: 0,
      otNightMinutes: 0,
      standardDays: 0,
    },
  );

  const byStatus: Record<string, number> = {};
  for (const r of rows) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;

  // Số dòng cần nhân sự xem. Tính ở server để mọi màn hình dùng cùng một định
  // nghĩa — nếu mỗi trang tự định nghĩa "cần xem" thì hai trang sẽ hiện hai số.
  //
  // CHỈ gồm trạng thái đòi hỏi một QUYẾT ĐỊNH của con người: thiếu quẹt (phải đi
  // xác minh) và vắng (phải xác nhận có đơn hay không).
  //
  // Bản đầu tiên gộp cả dòng có `warnings`, và với dữ liệu thật nó trả về 266/360
  // — vì mọi ngày có OT đều sinh một dòng thông báo. Một con số mà 74% số dòng đều
  // "cần xem" thì vô dụng. Nên cảnh báo được đếm RIÊNG ở dưới, với tên riêng.
  const needsReview = rows.filter(
    (r) => r.status === 'MISSING_PUNCH' || r.status === 'ABSENT',
  ).length;
  const withWarnings = rows.filter((r) => (r.warnings as string[] | null)?.length).length;

  return NextResponse.json({
    from,
    to,
    count: rows.length,
    byStatus,
    needsReview,
    withWarnings,
    totals,
    rows,
  });
}

// Dùng `sql` để TypeScript biết đây là module có side-effect import hợp lệ.
void sql;
