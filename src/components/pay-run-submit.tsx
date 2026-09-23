'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui';
import { api } from '@/lib/client-token';

/**
 * Nộp một kỳ lương ra duyệt. Chỉ hiện khi kỳ còn ở DRAFT.
 *
 * Ô "người nộp" đã bị BỎ. Trước đây client tự khai tên người nộp và server ghi
 * thẳng vào audit — nghĩa là ai cũng khai mình là người khác được. Nay server lấy
 * danh tính từ access token, nên ô đó không còn ý gì để nhập.
 */
export function PayRunSubmit({ payRunId, label }: { payRunId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api(`/api/pay-runs/${payRunId}/submit`, { method: 'POST', json: {} });
      const data = (await res.json()) as {
        requestId?: string;
        error?: { code?: string; message?: string };
      };
      if (!res.ok || !data.requestId) {
        // 403 và 401 đáng được nói rõ: "chưa đăng nhập" và "không có quyền nộp"
        // dẫn tới hai hành động khác nhau, và người dùng không tự suy ra được.
        if (data.error?.code === 'FORBIDDEN') {
          setError('Bạn không có quyền nộp bảng lương (cần payroll:submit).');
        } else {
          setError(data.error?.message ?? `Lỗi ${res.status}`);
        }
        return;
      }
      router.push(`/approvals/${data.requestId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={submit}
        className="rounded-md border border-[var(--accent-dim)] px-4 py-2 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {busy ? '…' : `Nộp ${label} ra duyệt`}
      </button>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
