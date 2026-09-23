import { eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { getDb } from '@/db/client';
import { employees, payslips, payRuns } from '@/db/schema';
import { Badge, Card, Alert } from '@/components/ui';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');

export default async function PayRunDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const db = getDb();

  const [run] = await db.select().from(payRuns).where(eq(payRuns.id, id)).limit(1);
  if (!run) notFound();

  const slips = await db
    .select({ s: payslips, region: employees.wageRegion, dependents: employees.dependents })
    .from(payslips)
    .innerJoin(employees, eq(payslips.employeeId, employees.id))
    .where(eq(payslips.payRunId, id));

  const snap = run.policySnapshot as Record<
    string,
    { code?: string; version?: number; resolvedAt?: string }
  >;

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <a href="/payroll" className="text-sm text-[var(--muted)] hover:underline">
          ← Bảng lương
        </a>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">
            Kỳ {String(run.periodMonth).padStart(2, '0')}/{run.periodYear}
          </h1>
          <Badge tone={run.status === 'DRAFT' ? 'warn' : 'active'}>{run.status}</Badge>
          <span className="text-sm text-[var(--muted)]">{slips.length} phiếu</span>
        </div>
      </div>

      <Card className="mb-6">
        <div className="text-sm font-medium">Chính sách đã áp dụng</div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Resolve một lần cho cả kỳ theo ngày{' '}
          <code>{String(snap.resolvedAt ?? '')}</code>. Không resolve trong vòng
          lặp — nếu ai đó kích hoạt chính sách mới giữa chừng thì hai nhân viên
          trong cùng một kỳ sẽ bị áp hai bộ luật.
        </p>
        <dl className="mt-3 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          {Object.entries(snap)
            .filter(([, v]) => typeof v === 'object' && v !== null && 'code' in v)
            .map(([kind, v]) => (
              <div key={kind}>
                <dt className="text-xs text-[var(--muted)]">{kind}</dt>
                <dd className="font-mono">
                  {v.code} v{v.version}
                </dd>
              </div>
            ))}
        </dl>
      </Card>

      <div className="mb-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        {[
          ['Tổng thu nhập', run.grossTotal],
          ['BH NLĐ', run.employeeSiTotal],
          ['BH NSDLĐ', run.employerSiTotal],
          ['Thuế TNCN', run.pitTotal],
          ['Thực nhận', run.netTotal],
        ].map(([label, value]) => (
          <Card key={label as string}>
            <div className="text-xs text-[var(--muted)]">{label}</div>
            <div className="num text-base font-semibold">{fmt(value as number)} đ</div>
          </Card>
        ))}
      </div>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="py-2 pr-3 font-normal">Mã</th>
                <th className="py-2 pr-3 font-normal">Họ tên</th>
                <th className="py-2 pr-3 font-normal">Vùng</th>
                <th className="num py-2 pr-3 font-normal">Thu nhập</th>
                <th className="num py-2 pr-3 font-normal">BH NLĐ</th>
                <th className="num py-2 pr-3 font-normal">Thuế</th>
                <th className="num py-2 pr-3 font-normal">Thực nhận</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {slips.map(({ s, region }) => (
                <tr key={s.id} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3 font-mono text-xs">{s.employeeCode}</td>
                  <td className="py-2 pr-3">{s.fullName}</td>
                  <td className="py-2 pr-3 text-xs">{region}</td>
                  <td className="num py-2 pr-3">{fmt(s.earningsTotal)}</td>
                  <td className="num py-2 pr-3">{fmt(s.siEmployee)}</td>
                  <td className="num py-2 pr-3">{fmt(s.pit)}</td>
                  <td className="num py-2 pr-3 font-medium">{fmt(s.netPay)}</td>
                  <td className="py-2 text-right">
                    <a
                      href={`/print/PHIEU_LUONG?payslip=${s.id}`}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-[var(--accent)] hover:underline"
                    >
                      In ↗
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Mỗi phiếu in ra dùng <strong>số liệu đã lưu</strong>, không tính lại —
          vì chính sách có thể đã đổi kể từ khi kỳ này được lập.
        </p>
      </Card>

      {run.status === 'DRAFT' && (
        <Alert tone="info">
          Kỳ này đang ở trạng thái <strong>DRAFT</strong>. Chưa có cơ chế duyệt
          và khoá (LOCK) — đó là phần workflow của Phase 4.
        </Alert>
      )}
    </main>
  );
}
