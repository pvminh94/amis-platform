import { desc } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { approvalRequests } from '@/db/schema';
import { Badge, Card, Alert } from '@/components/ui';
import { isFinalState, type RequestState } from '@/engine/workflow';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');

function toneOf(state: string): 'active' | 'warn' | 'danger' | 'neutral' {
  if (state === 'APPROVED') return 'active';
  if (state === 'REJECTED') return 'danger';
  if (state === 'PENDING_APPROVAL' || state === 'SUBMITTED') return 'warn';
  return 'neutral';
}

export default async function ApprovalsIndexPage() {
  const db = getDb();
  const rows = await db.select().from(approvalRequests).orderBy(desc(approvalRequests.createdAt));

  const open = rows.filter((r) => !isFinalState(r.state as RequestState)).length;

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6">
        <a href="/" className="text-sm text-[var(--muted)] hover:underline">
          ← Chính sách nghiệp vụ
        </a>
        <h1 className="mt-2 text-2xl font-semibold">Đơn xin duyệt</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {rows.length} đơn · <strong>{open} đang chờ</strong>
        </p>
      </div>

      <Alert tone="info">
        <strong>Ngưỡng duyệt là dữ liệu, máy trạng thái là code.</strong> "Chi trên
        200 triệu cần CEO" sửa được trên giao diện. Còn "đơn APPROVED không quay
        lại PENDING" thì không — cho sửa cái đó thì ai cũng tự duyệt được đơn của
        mình.
      </Alert>

      {rows.length === 0 ? (
        <Alert tone="warn">
          <strong>Chưa có đơn nào.</strong> Chạy <code>npm run demo:approval</code>,
          hoặc nộp một kỳ lương ra duyệt từ trang bảng lương.
        </Alert>
      ) : (
        <div className="mt-6 space-y-3">
          {rows.map((r) => {
            const chain = r.chain as Array<{ name: string }>;
            const snap = r.policySnapshot as { matchedLevel?: string; unit?: string };
            return (
              <Card key={r.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.docLabel}</span>
                      <Badge tone={toneOf(r.state)}>{r.state}</Badge>
                      <span className="text-xs text-[var(--muted)]">
                        bước {Math.min(r.currentStep + 1, r.totalSteps)}/{r.totalSteps}
                      </span>
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {r.docType}
                      {r.amount !== null ? ` · ${fmt(r.amount)} đ` : ''}
                      {snap.matchedLevel ? ` · cấp chốt: ${snap.matchedLevel}` : ''}
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      {chain.map((c) => c.name).join(' → ')}
                    </div>
                  </div>
                  <a
                    href={`/approvals/${r.id}`}
                    className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2)]"
                  >
                    {isFinalState(r.state as RequestState) ? 'Xem dấu vết' : 'Duyệt'} →
                  </a>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </main>
  );
}
