import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { policyKinds, policyVersions } from '@/db/schema';
import { Badge, Card, Alert } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const db = getDb();
  const kinds = await db.select().from(policyKinds);

  const enriched = await Promise.all(
    kinds.map(async (k) => {
      const rows = await db
        .select()
        .from(policyVersions)
        .where(eq(policyVersions.kindCode, k.code))
        .orderBy(desc(policyVersions.version));
      return { ...k, rows };
    }),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Chính sách nghiệp vụ</h1>
        <p className="mt-1.5 text-sm text-[var(--muted)]">
          Tham số luật nằm trong database. Sửa ở đây có hiệu lực ngay — không sửa code, không build, không deploy.
        </p>
      </div>

      <nav className="flex flex-wrap gap-2">
        {[
          ['/payroll', 'Bảng lương', 'Kỳ lương đã tính và phiếu của từng người'],
          ['/reports', 'Báo cáo', 'Định nghĩa JSON trong database, không chứa SQL'],
          ['/approvals', 'Đơn xin duyệt', 'Ngưỡng là dữ liệu, máy trạng thái là code'],
          ['/print', 'Mẫu in', 'HTML/CSS là dữ liệu — sửa mẫu không cần deploy'],
        ].map(([href, label, hint]) => (
          <a
            key={href}
            href={href}
            className="group rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2.5 transition-colors hover:border-[var(--accent-dim)]"
          >
            <span className="text-sm font-medium">{label}</span>
            <span className="block text-xs text-[var(--muted)]">{hint}</span>
          </a>
        ))}
      </nav>

      <Alert tone="info">
        Mỗi loại chính sách có nhiều <strong>phiên bản</strong>, mỗi phiên bản áp dụng cho một khoảng thời gian.
        Engine đọc phiên bản theo <strong>ngày của kỳ lương</strong>, nên phiếu lương cũ vẫn tái hiện đúng con số đã tính.
      </Alert>

      {enriched.length === 0 ? (
        <Card title="Chưa có loại chính sách nào">
          <p className="text-sm text-[var(--muted)]">
            Chạy <code className="rounded bg-[var(--panel-2)] px-1.5 py-0.5">npm run demo</code> để nạp dữ liệu mẫu.
          </p>
        </Card>
      ) : (
        <div className="grid gap-4">
          {enriched.map((k) => {
            const active = k.rows.filter((r) => r.status === 'ACTIVE');
            const draft = k.rows.filter((r) => r.status === 'DRAFT');
            const latest = k.rows[0];
            return (
              <Card
                key={k.code}
                title={k.nameVi}
                subtitle={k.description ?? undefined}
                actions={
                  <a
                    href={`/policies/${k.code}/new`}
                    className="inline-flex items-center rounded-md bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[#04140c] hover:bg-[#54e6a8]"
                  >
                    + Phiên bản mới
                  </a>
                }
              >
                <div className="mb-4 flex flex-wrap gap-2">
                  <Badge tone="active">{active.length} đang hiệu lực</Badge>
                  {draft.length > 0 && <Badge tone="warn">{draft.length} bản nháp</Badge>}
                  <Badge>{k.rows.length} tổng phiên bản</Badge>
                  <Badge tone="neutral">{k.code}</Badge>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                        <th className="py-2 pr-4">Phiên bản</th>
                        <th className="py-2 pr-4">Trạng thái</th>
                        <th className="py-2 pr-4">Hiệu lực từ</th>
                        <th className="py-2 pr-4">Đến</th>
                        <th className="py-2">Căn cứ pháp lý</th>
                      </tr>
                    </thead>
                    <tbody>
                      {k.rows.slice(0, 5).map((r) => (
                        <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                          <td className="py-2.5 pr-4 font-medium">v{r.version}</td>
                          <td className="py-2.5 pr-4">
                            <Badge tone={r.status === 'ACTIVE' ? 'active' : r.status === 'DRAFT' ? 'warn' : 'neutral'}>
                              {r.status}
                            </Badge>
                          </td>
                          <td className="py-2.5 pr-4 num">{r.effectiveFrom}</td>
                          <td className="py-2.5 pr-4 num">{r.effectiveTo ?? 'nay'}</td>
                          <td className="py-2.5 text-xs text-[var(--muted)]">{r.legalBasis ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="mt-4 flex justify-between text-xs text-[var(--muted)]">
                  <span>
                    Mới nhất: v{latest?.version} · cập nhật{' '}
                    {latest ? new Date(latest.updatedAt).toLocaleString('vi-VN') : '—'}
                  </span>
                  <a href={`/policies/${k.code}`} className="text-[var(--accent)] hover:underline">
                    Xem tất cả & dấu vết thay đổi →
                  </a>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
