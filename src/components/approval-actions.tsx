'use client';

import { useState } from 'react';
import { api } from '@/lib/client-token';
import { useRouter } from 'next/navigation';
import type { WorkflowAction } from '@/engine/workflow';
import { Alert } from '@/components/ui';

/**
 * Các nút hành động duyệt.
 *
 * Chỉ hiện những hành động MÁY TRẠNG THÁI cho phép ở trạng thái hiện tại —
 * danh sách do server tính bằng allowedActions(), không phải do client đoán.
 * Hiện một nút mà server sẽ từ chối là cách nhanh nhất để người dùng nghĩ hệ
 * thống bị lỗi.
 */

const LABELS: Record<string, string> = {
  APPROVE: 'Duyệt',
  REJECT: 'Từ chối',
  RETURN: 'Trả lại bổ sung',
  CANCEL: 'Huỷ đơn',
  SUBMIT: 'Nộp lại',
  ESCALATE: 'Chuyển cấp trên',
  REASSIGN: 'Giao người khác',
  AUTO_APPROVE: 'Duyệt tự động',
};

const TONES: Record<string, string> = {
  APPROVE: 'border-[var(--accent-dim)] text-[var(--accent)]',
  REJECT: 'border-[#5a1c22] text-[var(--danger)]',
  CANCEL: 'border-[#5a1c22] text-[var(--danger)]',
};

export function ApprovalActions({
  requestId,
  actions,
  stepLabel,
}: {
  requestId: string;
  actions: WorkflowAction[];
  stepLabel: string;
}) {
  const router = useRouter();
  const [comment, setComment] = useState('');
  const [actor, setActor] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (actions.length === 0) {
    return (
      <Alert tone="info">
        Đơn đã kết thúc — không còn hành động nào hợp lệ. Đây không phải lỗi:
        ba trạng thái cuối (APPROVED, REJECTED, CANCELLED) cố tình không có lối ra.
      </Alert>
    );
  }

  const run = async (action: WorkflowAction) => {
    setBusy(action);
    setError(null);
    try {
      // BUG ĐÃ SỬA: `fetch()` trần không gửi Authorization nên nút Duyệt/Từ chối
      // LUÔN nhận 401 — tức là toàn bộ luồng phê duyệt không dùng được từ giao
      // diện. Chuyển sang api() để tự gắn token và tự xử lý hết hạn.
      const res = await api(`/api/approvals/${requestId}`, {
        method: 'POST',
        json: { action, comment, actorId: actor || null },
      });
      const data = (await res.json()) as {
        state?: string;
        error?: { code?: string; message?: string };
      };
      if (!res.ok) {
        setError(data.error?.message ?? `Lỗi ${res.status}`);
        return;
      }
      setComment('');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-sm text-[var(--muted)]">{stepLabel}</div>
      <div className="grid gap-2 sm:grid-cols-2">
        <input
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-dim)]"
          placeholder="Người thực hiện (mã người dùng)"
          value={actor}
          onChange={(e) => setActor(e.target.value)}
        />
        <input
          className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-dim)]"
          placeholder="Lý do / ghi chú"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a}
            type="button"
            disabled={busy !== null}
            onClick={() => run(a)}
            className={`rounded-md border px-4 py-2 text-sm transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50 ${
              TONES[a] ?? 'border-[var(--border)]'
            }`}
          >
            {busy === a ? '…' : (LABELS[a] ?? a)}
          </button>
        ))}
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
