import { desc } from 'drizzle-orm';
import { requirePageSession } from '@/lib/page-auth';
import { getDb } from '@/db/client';
import { payRuns } from '@/db/schema';
import { Badge, Card, Alert } from '@/components/ui';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');

export default async function PayrollIndexPage() {
  // Trang RSC phai tu kiem tra phien — xem src/lib/page-auth.ts
  await requirePageSession();
  const db = getDb();
  const runs = await db.select().from(payRuns).orderBy(desc(payRuns.periodYear), desc(payRuns.periodMonth));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6">
        <a href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← Chính sách nghiệp vụ
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Bảng lương</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Mỗi kỳ lưu lại <strong>bộ tham số luật đã áp dụng</strong>. Ba năm sau
          vẫn tái hiện được đúng con số đã tính, dù chính sách đã đổi nhiều lần.
        </p>
      </div>

      {runs.length === 0 ? (
        <Alert tone="warn">
          <strong>Chưa có kỳ lương nào.</strong> Chạy <code>npm run payroll</code> để
          nạp nhân viên và tính một kỳ.
        </Alert>
      ) : (
        <div className="space-y-3">
          {runs.map((r) => {
            const snap = r.policySnapshot as {
              VN_SALARY?: { code: string; version: number };
              VN_BHXH?: { code: string; version: number };
              VN_PIT?: { code: string; version: number };
            };
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        Kỳ {String(r.periodMonth).padStart(2, '0')}/{r.periodYear}
                      </span>
                      <Badge tone={r.status === 'DRAFT' ? 'warn' : 'active'}>{r.status}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      lương: {snap.VN_SALARY?.code} v{snap.VN_SALARY?.version}
                      {' · '}BH: {snap.VN_BHXH?.code} v{snap.VN_BHXH?.version}
                      {' · '}thuế: {snap.VN_PIT?.code} v{snap.VN_PIT?.version}
                    </div>
                  </div>
                  <a
                    href={`/payroll/${r.id}`}
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                  >
                    Xem chi tiết →
                  </a>
                </div>

                <div className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                  {[
                    ['Tổng thu nhập', r.grossTotal],
                    ['BH người lao động', r.employeeSiTotal],
                    ['Thuế TNCN', r.pitTotal],
                    ['Thực nhận', r.netTotal],
                  ].map(([label, value]) => (
                    <div key={label as string}>
                      <div className="text-xs text-[var(--muted)]">{label}</div>
                      <div className="num font-medium">{fmt(value as number)} đ</div>
                    </div>
                  ))}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
