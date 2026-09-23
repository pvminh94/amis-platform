import { and, eq } from 'drizzle-orm';
import { AuthDownload } from '@/components/auth-download';
import { requirePageSession } from '@/lib/page-auth';
import { notFound } from 'next/navigation';
import { getDb, getPool } from '@/db/client';
import { policyVersions } from '@/db/schema';
import { reportParamsSchema } from '@/policy/report-params';
import { runReport } from '@/engine/report';
import { Badge, Card, Alert } from '@/components/ui';

export const dynamic = 'force-dynamic';

const fmtMoney = (n: number) => n.toLocaleString('vi-VN');

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  // Trang RSC phai tu kiem tra phien — xem src/lib/page-auth.ts
  await requirePageSession();
  const { code } = await params;
  const db = getDb();

  const rows = await db
    .select()
    .from(policyVersions)
    .where(
      and(
        eq(policyVersions.kindCode, 'REPORT_DEF'),
        eq(policyVersions.code, code),
        eq(policyVersions.status, 'ACTIVE'),
      ),
    )
    .limit(1);
  if (rows.length === 0) notFound();
  const row = rows[0]!;

  const parsed = reportParamsSchema.safeParse(row.params);
  if (!parsed.success) {
    return (
      <main className="mx-auto max-w-6xl px-6 py-10">
        <Alert tone="danger">
          <strong>Định nghĩa v{row.version} không hợp lệ.</strong>{' '}
          {parsed.error.issues.map((i) => i.message).join(' · ')}
        </Alert>
      </main>
    );
  }
  const def = parsed.data;

  const pool = getPool();
  let result;
  let failure: string | null = null;
  try {
    result = await runReport(def, async (sql, values) => {
      const r = await pool.query(sql, values);
      return r.rows as Record<string, unknown>[];
    });
  } catch (e) {
    result = null;
    failure = e instanceof Error ? e.message : String(e);
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <div className="mb-6">
        <a href="/reports" className="text-sm text-[var(--muted)] hover:underline">
          ← Báo cáo
        </a>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{def.regimeLabel}</h1>
          <Badge tone="active">v{row.version}</Badge>
          <AuthDownload
            href={`/api/reports/${code}?format=csv`}
            fileName={`${code}.csv`}
            label="Tải CSV ↓"
            className="ml-auto rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)] disabled:opacity-50"
          />
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">{def.description}</p>
      </div>

      {failure ? (
        <Alert tone="danger">
          <strong>Không chạy được báo cáo.</strong> {failure}
        </Alert>
      ) : result ? (
        <>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                    {result.columns.map((c) => (
                      <th
                        key={c.code}
                        className={`py-2 pr-3 font-normal ${c.isMeasure ? 'num text-right' : ''}`}
                      >
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((r, i) => (
                    <tr key={i} className="border-b border-[var(--border)]">
                      {result.columns.map((c) => {
                        // PostgreSQL trả khoá viết thường; mã cột của ta viết HOA.
                        const v = r[c.code.toLowerCase()] ?? r[c.code];
                        const isNum = typeof v === 'number' || /^\d+$/.test(String(v ?? ''));
                        return (
                          <td
                            key={c.code}
                            className={`num py-2 pr-3 ${c.isMeasure ? 'text-right' : ''}`}
                          >
                            {isNum
                              ? fmtMoney(Number(v)) + (c.type === 'money' ? ` ${def.currency}` : '')
                              : v === null || v === undefined
                                ? ''
                                : String(v)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-[var(--muted)]">
              {result.rows.length} dòng trong {result.durationMs}ms · giới hạn{' '}
              {def.limit.toLocaleString('vi-VN')} dòng
            </p>
          </Card>

          <Card className="mt-4">
            <div className="text-sm font-medium">Câu SQL đã sinh</div>
            <p className="mt-1 text-xs text-[var(--muted)]">
              Hiện ra để kiểm chứng. Một báo cáo cho số sai mà không ai xem được
              nó gộp cái gì thì tệ hơn là không có báo cáo — người ta sẽ tin nó.
              Tên cột đến từ whitelist, còn mọi giá trị đi qua tham số{' '}
              <code>$1, $2…</code>.
            </p>
            <pre className="mt-3 overflow-x-auto rounded-md bg-[var(--panel-2)] p-3 text-xs leading-relaxed">
              {result.sql}
            </pre>
            <div className="mt-2 text-xs text-[var(--muted)]">
              tham số: {result.values.length === 0 ? '(không có)' : JSON.stringify(result.values)}
            </div>
          </Card>
        </>
      ) : null}
    </main>
  );
}
