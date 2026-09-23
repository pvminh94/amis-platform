'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui';
import { api } from '@/lib/client-token';

interface Summary {
  daysProcessed: number;
  rowsWritten: number;
  byStatus: Record<string, number>;
  totals: { workedMinutes: number; nightMinutes: number; standardDays: number };
  orphanPunches: { employeeCode: string; localDate: string }[];
  errors: { employeeCode: string; workDate: string; code: string; message: string }[];
}

/**
 * Tính lại công cho một khoảng ngày.
 *
 * Hiện CẢ lỗi từng dòng lẫn quẹt mồ côi, không chỉ con số "đã ghi N dòng".
 * Lý do: một đợt tính ghi đủ 360 dòng nhưng có 12 dòng lỗi thì bảng lương vẫn
 * sai, và nếu giao diện chỉ hiện "thành công" thì không ai biết mà đi sửa.
 */
export function AttendanceRecompute({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api('/api/attendance/compute', {
        method: 'POST',
        json: { from, to },
      });
      const data = (await res.json()) as Summary & { error?: { code?: string; message?: string } };
      if (!res.ok) {
        setError(
          data.error?.code === 'FORBIDDEN'
            ? 'Bạn không có quyền tính lại công (cần attendance:compute).'
            : (data.error?.message ?? `Lỗi ${res.status}`),
        );
        return;
      }
      setResult(data);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        type="button"
        disabled={busy}
        onClick={run}
        className="rounded-md border border-[var(--accent-dim)] px-4 py-2 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
      >
        {busy ? 'Đang tính…' : `Tính lại công ${from} → ${to}`}
      </button>

      {error && <Alert tone="danger">{error}</Alert>}

      {result && (
        <Alert tone={result.errors.length || result.orphanPunches.length ? 'warn' : 'info'}>
          <p>
            Đã xử lý <strong>{result.daysProcessed}</strong> ngày công, ghi{' '}
            <strong>{result.rowsWritten}</strong> dòng ·{' '}
            {(result.totals.workedMinutes / 60).toFixed(1)} giờ công ·{' '}
            {result.totals.standardDays.toFixed(2)} công quy chuẩn.
          </p>
          {result.orphanPunches.length > 0 && (
            <p className="mt-1">
              ⚠ <strong>{result.orphanPunches.length} quẹt mồ côi</strong> — không thuộc ngày công
              nào (thường là thiếu lịch xếp ca):{' '}
              {result.orphanPunches
                .slice(0, 6)
                .map((o) => `${o.employeeCode} ${o.localDate}`)
                .join(' · ')}
              {result.orphanPunches.length > 6 ? '…' : ''}
            </p>
          )}
          {result.errors.length > 0 && (
            <p className="mt-1">
              ✗ <strong>{result.errors.length} dòng lỗi</strong> — các dòng còn lại vẫn được tính:{' '}
              {result.errors
                .slice(0, 4)
                .map((e) => `${e.employeeCode} ${e.workDate}: ${e.message}`)
                .join(' · ')}
              {result.errors.length > 4 ? '…' : ''}
            </p>
          )}
        </Alert>
      )}
    </div>
  );
}
