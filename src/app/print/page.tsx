import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { policyVersions } from '@/db/schema';
import { printParamsSchema } from '@/policy/print-params';
import { Badge, Card, Alert } from '@/components/ui';

export const dynamic = 'force-dynamic';

/**
 * Danh sách mẫu in đang hiệu lực, kèm link mở bản in.
 *
 * Đây là server component đọc thẳng DB — không có state, không fetch phía
 * client, nên không cần loading state.
 */
export default async function PrintIndexPage() {
  const db = getDb();
  const rows = await db
    .select()
    .from(policyVersions)
    .where(eq(policyVersions.kindCode, 'PRINT'))
    .orderBy(desc(policyVersions.version));

  const active = rows.filter((r) => r.status === 'ACTIVE');

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <div className="mb-6">
        <a href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← Chính sách nghiệp vụ
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Mẫu in</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Mẫu là dữ liệu trong database. Kế toán sửa tiêu đề, thêm dòng, đổi công
          thức một cột ngay trên giao diện — không cần developer, không cần
          deploy. Mở bản in rồi dùng <strong>In → Lưu thành PDF</strong> của trình
          duyệt để xuất file.
        </p>
      </div>

      {active.length === 0 ? (
        <Alert tone="warn">
          <strong>Chưa có mẫu in nào.</strong> Chạy <code>npm run seed:print</code> để
          nạp mẫu phiếu lương.
        </Alert>
      ) : (
        <div className="space-y-4">
          {active.map((v) => {
            const parsed = printParamsSchema.safeParse(v.params);
            if (!parsed.success) {
              return (
                <Card key={v.id}>
                  <Alert tone="danger">
                    <strong>v{v.version}: tham số không hợp lệ.</strong>{' '}
                    {parsed.error.issues[0]?.message ?? 'Lỗi không xác định'}
                  </Alert>
                </Card>
              );
            }
            const p = parsed.data;
            const computed = p.fields.filter((f) => f.expr.trim() !== '');
            return (
              <Card key={v.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.regimeLabel}</span>
                      <Badge tone="active">v{v.version}</Badge>
                      <Badge tone="neutral">{p.regimeCode}</Badge>
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {p.paperSize} · {p.orientation === 'portrait' ? 'dọc' : 'ngang'} · lề{' '}
                      {p.marginMm.top}/{p.marginMm.right}/{p.marginMm.bottom}/{p.marginMm.left} mm
                      {' · '}
                      {p.fields.length} trường ({computed.length} có biểu thức)
                      {effectiveRange(v.effectiveFrom, v.effectiveTo)}
                    </div>
                  </div>
                  <a
                    href={`/print/${encodeURIComponent(p.regimeCode)}`}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                  >
                    Mở bản in ↗
                  </a>
                </div>

                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-[var(--muted)]">
                    Xem các trường dữ liệu
                  </summary>
                  <table className="mt-2 w-full text-left">
                    <thead>
                      <tr className="text-[var(--muted)]">
                        <th className="py-1 pr-3 font-normal">Mã</th>
                        <th className="py-1 pr-3 font-normal">Nhãn</th>
                        <th className="py-1 pr-3 font-normal">Biểu thức</th>
                        <th className="py-1 font-normal">Định dạng</th>
                      </tr>
                    </thead>
                    <tbody>
                      {p.fields.map((f) => (
                        <tr key={f.code} className="border-t border-[var(--border)]">
                          <td className="py-1 pr-3 font-mono">{f.code}</td>
                          <td className="py-1 pr-3">{f.label}</td>
                          <td className="py-1 pr-3 font-mono text-[var(--muted)]">
                            {f.expr.trim() === '' ? '— lấy từ dữ liệu —' : f.expr}
                          </td>
                          <td className="py-1">{f.format}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              </Card>
            );
          })}
        </div>
      )}

      <Card className="mt-8">
        <div className="text-sm font-medium">Thử với dữ liệu khác</div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Thêm tham số vào URL của bản in, ví dụ:
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-[var(--surface-2)] p-3 text-xs">
{`/print/PHIEU_LUONG?ten=Trần%20Thị%20B&luong=40000000&kpi=92
                 &ky=2026-03-31&phuThuoc=2&region=II&ngayCong=18`}
        </pre>
        <p className="mt-2 text-xs text-[var(--muted)]">
          Đổi <code>ky=2026-03-31</code> sẽ áp bộ luật của nửa đầu 2026 — mức
          tham chiếu, biểu thuế và giảm trừ đều khác. Không sửa một dòng code.
        </p>
      </Card>
    </main>
  );
}

function effectiveRange(from: Date | string, to: Date | string | null): string {
  const f = (d: Date | string) => (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10));
  return ` · hiệu lực ${f(from)} → ${to ? f(to) : 'nay'}`;
}
