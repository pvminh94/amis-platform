import { and, desc, eq } from 'drizzle-orm';
import { requirePageSession } from '@/lib/page-auth';
import { getDb } from '@/db/client';
import { policyVersions } from '@/db/schema';
import { reportParamsSchema } from '@/policy/report-params';
import { Badge, Card, Alert } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function ReportsIndexPage() {
  // Trang RSC phai tu kiem tra phien — xem src/lib/page-auth.ts
  await requirePageSession();
  const db = getDb();
  const rows = await db
    .select()
    .from(policyVersions)
    .where(and(eq(policyVersions.kindCode, 'REPORT_DEF'), eq(policyVersions.status, 'ACTIVE')))
    .orderBy(desc(policyVersions.updatedAt));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6">
        <a href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← Chính sách nghiệp vụ
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Báo cáo</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Mỗi báo cáo là một <strong>định nghĩa JSON trong database</strong>: nguồn
          dữ liệu, cột nhóm, chỉ tiêu, điều kiện lọc. Thêm báo cáo mới không cần
          viết code.
        </p>
      </div>

      <Alert tone="info">
        Một định nghĩa báo cáo <strong>không bao giờ chứa SQL</strong>. Người dùng
        chỉ chọn từ danh sách cột đã whitelist; engine ghép câu truy vấn từ những
        mảnh viết sẵn và mọi giá trị đi qua tham số <code>$1, $2…</code>. Không có
        đường nào để một chuỗi nhập vào lọt thành mã SQL.
      </Alert>

      {rows.length === 0 ? (
        <Alert tone="warn">
          <strong>Chưa có báo cáo nào.</strong> Chạy <code>npm run seed:report</code>{' '}
          để nạp hai báo cáo mẫu.
        </Alert>
      ) : (
        <div className="mt-6 space-y-3">
          {rows.map((r) => {
            const parsed = reportParamsSchema.safeParse(r.params);
            if (!parsed.success) {
              return (
                <Card key={r.id}>
                  <Badge tone="danger">v{r.version} hỏng</Badge>
                  <p className="mt-2 text-sm text-[var(--muted)]">
                    {parsed.error.issues[0]?.message ?? 'Định nghĩa không hợp lệ'}
                  </p>
                </Card>
              );
            }
            const p = parsed.data;
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{p.regimeLabel}</span>
                      <Badge tone="active">v{r.version}</Badge>
                    </div>
                    <div className="mt-0.5 font-mono text-xs text-[var(--muted)]">{p.regimeCode}</div>
                    <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">{p.description}</p>
                  </div>
                  <div className="flex gap-2">
                    <a
                      href={`/reports/${p.regimeCode}`}
                      className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                    >
                      Chạy →
                    </a>
                    <a
                      href={`/api/reports/${p.regimeCode}?format=csv`}
                      className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                    >
                      CSV
                    </a>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                  <span>nguồn: {p.source}</span>
                  <span>{p.dimensions.length} cột nhóm</span>
                  <span>{p.measures.length} chỉ tiêu</span>
                  <span>{p.filters.length} điều kiện</span>
                  <span>giới hạn {p.limit.toLocaleString('vi-VN')} dòng</span>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
