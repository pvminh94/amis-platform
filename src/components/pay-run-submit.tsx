'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui';

/** Nộp một kỳ lương ra duyệt. Chỉ hiện khi kỳ còn ở DRAFT. */
export function PayRunSubmit({ payRunId, label }: { payRunId: string; label: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actor, setActor] = useState('kt01');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/pay-runs/${payRunId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorId: actor || 'anonymous' }),
      });
      const data = (await res.json()) as {
        requestId?: string;
        error?: { message?: string };
      };
      if (!res.ok || !data.requestId) {
        setError(data.error?.message ?? `Lỗi ${res.status}`);
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
      <input
        className="w-40 rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm outline-none focus:border-[var(--accent-dim)]"
        value={actor}
        onChange={(e) => setActor(e.target.value)}
        placeholder="Người nộp"
      />
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
