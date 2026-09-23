import { and, eq, gte, lte, sql } from 'drizzle-orm';

import { dailyAttendance, employees } from '@/db/schema';
import { getDb } from '@/db/client';
import { Alert, Badge, Card } from '@/components/ui';
import { AttendanceRecompute } from '@/components/attendance-recompute';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');
const h = (min: number) => (min / 60).toFixed(1);

/** Tháng hiện tại theo giờ VN, dạng YYYY-MM. */
function currentMonth(): string {
  const now = new Date(Date.now() + 7 * 3600_000);
  return now.toISOString().slice(0, 7);
}

function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}

function shiftMonth(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return d.toISOString().slice(0, 7);
}

const STATUS_TONE: Record<string, 'active' | 'warn' | 'danger' | 'neutral'> = {
  PRESENT: 'active',
  LATE: 'warn',
  HALF_DAY: 'warn',
  MISSING_PUNCH: 'danger',
  ABSENT: 'danger',
  WEEKLY_OFF: 'neutral',
  HOLIDAY_OFF: 'neutral',
  LEAVE_PAID: 'neutral',
};

const STATUS_VI: Record<string, string> = {
  PRESENT: 'Đủ công',
  LATE: 'Đi trễ',
  HALF_DAY: 'Nửa ngày',
  MISSING_PUNCH: 'Thiếu quẹt',
  ABSENT: 'Vắng',
  WEEKLY_OFF: 'Nghỉ hằng tuần',
  HOLIDAY_OFF: 'Nghỉ lễ',
  LEAVE_PAID: 'Nghỉ phép',
};

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const sp = await searchParams;
  const ym = /^\d{4}-\d{2}$/.test(sp.month ?? '') ? sp.month! : currentMonth();
  const { from, to } = monthBounds(ym);

  const db = getDb();
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
      otWeekdayMinutes: dailyAttendance.otWeekdayMinutes,
      otWeekendMinutes: dailyAttendance.otWeekendMinutes,
      otHolidayMinutes: dailyAttendance.otHolidayMinutes,
      otNightMinutes: dailyAttendance.otNightMinutes,
      warnings: dailyAttendance.warnings,
    })
    .from(dailyAttendance)
    .leftJoin(employees, eq(employees.employeeCode, dailyAttendance.employeeCode))
    .where(and(gte(dailyAttendance.workDate, from), lte(dailyAttendance.workDate, to)))
    .orderBy(dailyAttendance.workDate, dailyAttendance.employeeCode);

  const byStatus = await db
    .select({ status: dailyAttendance.status, n: sql<number>`count(*)::int` })
    .from(dailyAttendance)
    .where(and(gte(dailyAttendance.workDate, from), lte(dailyAttendance.workDate, to)))
    .groupBy(dailyAttendance.status);

  const totals = await db
    .select({
      worked: sql<number>`coalesce(sum(worked_minutes),0)::int`,
      night: sql<number>`coalesce(sum(night_minutes),0)::int`,
      otWd: sql<number>`coalesce(sum(ot_weekday_minutes),0)::int`,
      otWe: sql<number>`coalesce(sum(ot_weekend_minutes),0)::int`,
      otHo: sql<number>`coalesce(sum(ot_holiday_minutes),0)::int`,
      otNi: sql<number>`coalesce(sum(ot_night_minutes),0)::int`,
      days: sql<number>`coalesce(sum(standard_days),0)::float`,
    })
    .from(dailyAttendance)
    .where(and(gte(dailyAttendance.workDate, from), lte(dailyAttendance.workDate, to)));
  const t = totals[0]!;

  // Dòng cần nhân sự xem. Đây là phần QUAN TRỌNG NHẤT của trang: một bảng chấm
  // công mà phải cuộn 360 dòng để tìm 8 dòng có vấn đề thì không dùng được.
  //
  // Chỉ lấy trạng thái đòi hỏi quyết định của con người. Dòng chỉ có cảnh báo
  // thông thường (phát sinh OT) được đếm riêng, không trộn vào đây — trộn vào
  // thì danh sách này dài 266 dòng và không còn ai đọc.
  const review = rows.filter((r) => r.status === 'MISSING_PUNCH' || r.status === 'ABSENT');
  const withWarnings = rows.filter(
    (r) => Array.isArray(r.warnings) && (r.warnings as string[]).length > 0,
  ).length;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <a href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← Chính sách nghiệp vụ
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Chấm công</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Tháng {ym} ({from} → {to}) · {rows.length} ngày công
        </p>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <a
          href={`/attendance?month=${shiftMonth(ym, -1)}`}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
        >
          ← Tháng trước
        </a>
        <a
          href={`/attendance?month=${shiftMonth(ym, 1)}`}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
        >
          Tháng sau →
        </a>
      </div>

      <Alert tone="info">
        <strong>Bảng này là dữ liệu DẪN XUẤT.</strong> Nguồn sự thật là{' '}
        <code>raw_punches</code> — chỉ thêm, không sửa, không xoá. Mọi con số ở đây
        tính lại được từ quẹt thô cộng với lịch và chính sách, nên nút tính lại bên
        dưới chạy bao nhiêu lần cũng ra cùng một kết quả.
      </Alert>

      <div className="mt-6">
        <Card title="Tính lại công">
          <AttendanceRecompute from={from} to={to} />
        </Card>
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {[
          ['Giờ công', `${h(t.worked)} h`],
          ['Giờ đêm (phụ cấp 30%)', `${h(t.night)} h`],
          ['Công quy chuẩn', t.days.toFixed(2)],
          ['OT ngày thường / cuối tuần / lễ', `${h(t.otWd)} / ${h(t.otWe)} / ${h(t.otHo)} h`],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="text-xs text-[var(--muted)]">{label}</div>
            <div className="mt-1 text-xl font-semibold">{value}</div>
          </div>
        ))}
      </div>

      <p className="mt-3 text-xs text-[var(--muted)]">
        {review.length} ngày cần quyết định · {withWarnings} ngày có ghi chú thông thường
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        {byStatus
          .sort((a, b) => b.n - a.n)
          .map((s) => (
            <Badge key={s.status} tone={STATUS_TONE[s.status] ?? 'neutral'}>
              {STATUS_VI[s.status] ?? s.status}: {s.n}
            </Badge>
          ))}
      </div>

      {review.length > 0 && (
        <div className="mt-6">
          <Card title={`Cần nhân sự xem — ${review.length} ngày`}>
            <ul className="space-y-1.5 text-sm">
              {review.slice(0, 40).map((r) => (
                <li key={`${r.employeeCode}-${r.workDate}`} className="flex flex-wrap gap-2">
                  <span className="font-mono text-xs text-[var(--muted)]">{r.workDate}</span>
                  <span className="font-medium">
                    {r.employeeCode} {r.fullName ?? ''}
                  </span>
                  <Badge tone={STATUS_TONE[r.status] ?? 'warn'}>
                    {STATUS_VI[r.status] ?? r.status}
                  </Badge>
                  {(r.warnings as string[] | null)?.map((w) => (
                    <span key={w} className="text-xs text-[var(--muted)]">
                      {w}
                    </span>
                  ))}
                </li>
              ))}
              {review.length > 40 && (
                <li className="text-xs text-[var(--muted)]">… và {review.length - 40} dòng khác</li>
              )}
            </ul>
          </Card>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="mt-6">
          <Alert tone="warn">
            <strong>Chưa có dữ liệu tháng này.</strong> Chạy{' '}
            <code>npm run seed:attendance</code> để có lịch xếp ca và quẹt thẻ mẫu,
            rồi bấm nút tính lại ở trên.
          </Alert>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-sm">
            <thead className="bg-[var(--surface-2)] text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="px-3 py-2">Ngày</th>
                <th className="px-3 py-2">Nhân viên</th>
                <th className="px-3 py-2">Ca</th>
                <th className="px-3 py-2">Trạng thái</th>
                <th className="px-3 py-2 text-right">Giờ công</th>
                <th className="px-3 py-2 text-right">Giờ đêm</th>
                <th className="px-3 py-2 text-right">Trễ</th>
                <th className="px-3 py-2 text-right">OT</th>
                <th className="px-3 py-2 text-right">Công</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 400).map((r) => {
                const ot = r.otWeekdayMinutes + r.otWeekendMinutes + r.otHolidayMinutes;
                return (
                  <tr
                    key={`${r.employeeCode}-${r.workDate}`}
                    className="border-t border-[var(--border)]"
                  >
                    <td className="px-3 py-1.5 font-mono text-xs">{r.workDate.slice(5)}</td>
                    <td className="px-3 py-1.5">
                      {r.employeeCode}
                      <span className="ml-1 text-xs text-[var(--muted)]">{r.fullName ?? ''}</span>
                    </td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.shiftCode}</td>
                    <td className="px-3 py-1.5">
                      <Badge tone={STATUS_TONE[r.status] ?? 'neutral'}>
                        {STATUS_VI[r.status] ?? r.status}
                      </Badge>
                    </td>
                    <td className="px-3 py-1.5 text-right">{h(r.workedMinutes)}</td>
                    <td className="px-3 py-1.5 text-right">
                      {r.nightMinutes > 0 ? h(r.nightMinutes) : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right">
                      {r.lateMinutes > 0 ? `${r.lateMinutes}'` : '—'}
                    </td>
                    <td className="px-3 py-1.5 text-right">{ot > 0 ? h(ot) : '—'}</td>
                    <td className="px-3 py-1.5 text-right">{Number(r.standardDays).toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length > 400 && (
            <p className="border-t border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
              Hiển thị 400/{fmt(rows.length)} dòng. Lọc theo nhân viên ở API:{' '}
              <code>/api/attendance?from={from}&amp;to={to}&amp;employeeCode=…</code>
            </p>
          )}
        </div>
      )}
    </main>
  );
}
