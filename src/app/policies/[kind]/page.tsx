import { notFound } from 'next/navigation';
import { desc, eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { policyAuditLogs, policyKinds, policyVersions } from '@/db/schema';
import { Badge, Card } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function KindPage({ params }: { params: Promise<{ kind: string }> }) {
  const { kind } = await params;
  const db = getDb();

  const kinds = await db.select().from(policyKinds).where(eq(policyKinds.code, kind)).limit(1);
  const k = kinds[0];
  if (!k) notFound();

  const versions = await db
    .select()
    .from(policyVersions)
    .where(eq(policyVersions.kindCode, kind))
    .orderBy(desc(policyVersions.version));

  const audit = await db
    .select()
    .from(policyAuditLogs)
    .where(eq(policyAuditLogs.kindCode, kind))
    .orderBy(desc(policyAuditLogs.at))
    .limit(30);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <a href="/" className="text-xs text-[var(--muted)] hover:underline">← Tất cả chính sách</a>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">{k.nameVi}</h1>
          {k.description && <p className="mt-1.5 max-w-2xl text-sm text-[var(--muted)]">{k.description}</p>}
        </div>
        <a
          href={`/policies/${kind}/new`}
          className="inline-flex shrink-0 items-center rounded-md bg-[var(--accent)] px-3.5 py-2 text-sm font-medium text-[#04140c] hover:bg-[#54e6a8]"
        >
          + Phiên bản mới
        </a>
      </div>

      <Card title="Các phiên bản" subtitle="Sắp theo phiên bản mới nhất">
        <div className="space-y-3">
          {versions.map((v) => (
            <div key={v.id} className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">v{v.version}</span>
                <Badge tone={v.status === 'ACTIVE' ? 'active' : v.status === 'DRAFT' ? 'warn' : 'neutral'}>
                  {v.status}
                </Badge>
                <span className="num text-sm text-[var(--muted)]">
                  {v.effectiveFrom} → {v.effectiveTo ?? 'nay'}
                </span>
                {v.approvedBy && (
                  <span className="text-xs text-[var(--muted)]">
                    duyệt bởi {v.approvedBy}
                    {v.approvedAt ? ` · ${new Date(v.approvedAt).toLocaleDateString('vi-VN')}` : ''}
                  </span>
                )}
              </div>
              {v.legalBasis && (
                <p className="mt-2 text-xs text-[var(--muted)]">
                  <span className="uppercase tracking-wide">Căn cứ:</span> {v.legalBasis}
                </p>
              )}
              <details className="mt-2">
                <summary className="cursor-pointer text-xs text-[var(--accent)] hover:underline">
                  Xem tham số
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto rounded bg-[var(--bg)] p-3 text-[11px] leading-relaxed">
{JSON.stringify(v.params, null, 2)}
                </pre>
              </details>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Dấu vết thay đổi" subtitle="Mọi thao tác đều được ghi lại — dữ liệu pháp lý không được sửa mà không có dấu vết">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
              <th className="py-2 pr-4">Thời điểm</th>
              <th className="py-2 pr-4">Thao tác</th>
              <th className="py-2 pr-4">Phiên bản</th>
              <th className="py-2 pr-4">Người thực hiện</th>
              <th className="py-2">Lý do</th>
            </tr>
          </thead>
          <tbody>
            {audit.map((a) => (
              <tr key={a.id} className="border-b border-[var(--border)] last:border-0">
                <td className="py-2 pr-4 num text-xs">{new Date(a.at).toLocaleString('vi-VN')}</td>
                <td className="py-2 pr-4">
                  <Badge tone={a.action === 'ACTIVATE' ? 'active' : a.action === 'ARCHIVE' ? 'neutral' : 'warn'}>
                    {a.action}
                  </Badge>
                </td>
                <td className="py-2 pr-4 num">{a.version ?? '—'}</td>
                <td className="py-2 pr-4 text-xs">{a.actorId}</td>
                <td className="py-2 text-xs text-[var(--muted)]">{a.reason ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
