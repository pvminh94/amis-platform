import { asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';
import { isUuid } from '@/lib/uuid';
import { getDb } from '@/db/client';
import { approvalAudit, approvalRequests } from '@/db/schema';
import { allowedActions, isFinalState, type RequestState, type WorkflowAction } from '@/engine/workflow';
import { Badge, Card } from '@/components/ui';
import { ApprovalActions } from '@/components/approval-actions';

export const dynamic = 'force-dynamic';

const fmt = (n: number) => n.toLocaleString('vi-VN');

function toneOf(state: string): 'active' | 'warn' | 'danger' | 'neutral' {
  if (state === 'APPROVED') return 'active';
  if (state === 'REJECTED') return 'danger';
  if (state === 'PENDING_APPROVAL' || state === 'SUBMITTED') return 'warn';
  return 'neutral';
}

export default async function ApprovalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Chặn ở đây: id không đúng dạng UUID sẽ làm PostgreSQL ném 22P02 và người
  // dùng nhận 500 thay vì 404.
  if (!isUuid(id)) notFound();
  const db = getDb();

  const [req] = await db
    .select()
    .from(approvalRequests)
    .where(eq(approvalRequests.id, id))
    .limit(1);
  if (!req) notFound();

  const chain = req.chain as Array<{ order: number; code: string; name: string; isMatched: boolean }>;
  const snap = req.policySnapshot as {
    APPROVAL?: { code: string; version: number };
    matchedLevel?: string;
    matchedUpto?: number | null;
    unit?: string;
  };
  const context = req.context as Record<string, unknown>;

  const trail = await db
    .select()
    .from(approvalAudit)
    .where(eq(approvalAudit.requestId, id))
    .orderBy(asc(approvalAudit.at));

  const actions = allowedActions(req.state as RequestState) as WorkflowAction[];
  const currentLevel = chain[req.currentStep];

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <div className="mb-6">
        <a href="/approvals" className="text-sm text-[var(--muted)] hover:underline">
          ← Đơn xin duyệt
        </a>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{req.docLabel}</h1>
          <Badge tone={toneOf(req.state)}>{req.state}</Badge>
          {req.amount !== null && (
            <span className="num text-lg">{fmt(req.amount)} đ</span>
          )}
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {req.docType} · ngưỡng{' '}
          {snap.matchedUpto === null
            ? 'không giới hạn'
            : `< ${fmt(snap.matchedUpto ?? 0)} ${snap.unit ?? ''}`}{' '}
          · cấp chốt <strong>{snap.matchedLevel}</strong> · chính sách{' '}
          <code>
            {snap.APPROVAL?.code} v{snap.APPROVAL?.version}
          </code>
        </p>
      </div>

      <Card className="mb-4">
        <div className="text-sm font-medium">Chuỗi duyệt</div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Chụp lúc nộp đơn. Nếu đọc lại từ chính sách mỗi lần, một thay đổi ngưỡng
          giữa chừng sẽ đổi số bước của đơn đang duyệt dở — đơn "bước 2/3" bỗng
          thành "bước 2/2" và tự chốt.
        </p>
        <ol className="mt-3 space-y-1.5">
          {chain.map((c, i) => {
            const done = i < req.currentStep || req.state === 'APPROVED';
            const current = i === req.currentStep && !isFinalState(req.state as RequestState);
            return (
              <li key={c.order} className="flex items-center gap-2 text-sm">
                <span
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-[11px] ${
                    done
                      ? 'border-[var(--accent-dim)] text-[var(--accent)]'
                      : current
                        ? 'border-[var(--warn)] text-[var(--warn)]'
                        : 'border-[var(--border)] text-[var(--muted)]'
                  }`}
                >
                  {i + 1}
                </span>
                <span className={done || current ? '' : 'text-[var(--muted)]'}>{c.name}</span>
                {c.isMatched && (
                  <span className="text-xs text-[var(--muted)]">(cấp do ngưỡng chỉ định)</span>
                )}
                {current && <Badge tone="warn">đang chờ</Badge>}
              </li>
            );
          })}
        </ol>
      </Card>

      <Card className="mb-4">
        <ApprovalActions
          requestId={req.id}
          actions={actions}
          stepLabel={
            isFinalState(req.state as RequestState)
              ? 'Đơn đã kết thúc.'
              : `Đang ở bước ${req.currentStep + 1}/${req.totalSteps}${
                  currentLevel ? ` — chờ ${currentLevel.name}` : ''
                }`
          }
        />
      </Card>

      <Card>
        <div className="text-sm font-medium">Dấu vết ({trail.length} bản ghi)</div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Bảng này <strong>chỉ cho phép INSERT</strong> — bất biến được ép bằng
          trigger ở tầng database, không chỉ bằng quy ước trong code. Một audit
          trail mà ai có quyền DB cũng sửa được thì không trả lời được câu hỏi duy
          nhất nó tồn tại để trả lời.
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-left text-xs text-[var(--muted)]">
                <th className="py-2 pr-3 font-normal">Lúc</th>
                <th className="py-2 pr-3 font-normal">Hành động</th>
                <th className="py-2 pr-3 font-normal">Chuyển</th>
                <th className="py-2 pr-3 font-normal">Người</th>
                <th className="py-2 pr-3 font-normal">IP</th>
                <th className="py-2 font-normal">Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {trail.map((a) => (
                <tr key={a.id} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-3 font-mono text-xs">
                    {a.at.toISOString().replace('T', ' ').slice(0, 19)}
                  </td>
                  <td className="py-2 pr-3">{a.action}</td>
                  <td className="py-2 pr-3 text-xs text-[var(--muted)]">
                    {a.fromStatus} → {a.toStatus}
                  </td>
                  <td className="py-2 pr-3">
                    {a.actorId ?? '—'}
                    {a.actorRole ? (
                      <span className="text-xs text-[var(--muted)]"> ({a.actorRole})</span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{a.ipAddress}</td>
                  <td className="py-2 text-xs text-[var(--muted)]">{a.comment ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <details className="mt-3 text-xs text-[var(--muted)]">
          <summary>Ngữ cảnh đơn dùng để đánh giá điều kiện</summary>
          <pre className="mt-2 overflow-x-auto rounded-md bg-[var(--panel-2)] p-3">
            {JSON.stringify(context, null, 2)}
          </pre>
        </details>
      </Card>
    </main>
  );
}
