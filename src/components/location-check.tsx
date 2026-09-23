'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

import { Alert } from '@/components/ui';
import { api } from '@/lib/client-token';

type GeoStatus = 'TRUSTED' | 'REVIEW' | 'REJECTED' | 'NO_FENCE' | 'NO_GPS';

interface Summary {
  checked: number;
  byStatus: Record<GeoStatus, number>;
  sitesWithoutFence: string[];
  rejectedByEmployee: { employeeCode: string; count: number }[];
  errors: string[];
}

const LABEL: Record<GeoStatus, string> = {
  TRUSTED: 'Đáng tin',
  REVIEW: 'Cần rà soát',
  REJECTED: 'Từ chối',
  NO_FENCE: 'Chưa có hàng rào',
  NO_GPS: 'Không có GPS',
};

/**
 * Kiểm tra vị trí quẹt thẻ theo geofence.
 *
 * Hiện ĐỦ NĂM trạng thái, kể cả hai trạng thái "không kết luận được". Lý do:
 * nếu chỉ hiện "36 quẹt bị từ chối" thì người vận hành sẽ đi xử lý 36 người lao
 * động, trong khi nguyên nhân thật có thể là MỘT địa điểm chưa được vẽ hàng rào
 * hoặc MỘT phiên bản iOS vừa đổi quyền đọc vị trí. Hai trạng thái NO_FENCE và
 * NO_GPS tồn tại chính là để hai nguyên nhân đó không bị trộn vào gian lận.
 */
export function LocationCheck({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api('/api/attendance/check-locations', {
        method: 'POST',
        json: { from, to },
      });
      const data = (await res.json()) as Summary & { error?: { code?: string; message?: string } };
      if (!res.ok) {
        setError(
          data.error?.code === 'FORBIDDEN'
            ? 'Bạn không có quyền kiểm tra vị trí (cần attendance:compute).'
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
        {busy ? 'Đang kiểm tra…' : `Kiểm tra vị trí quẹt ${from} → ${to}`}
      </button>

      <p className="text-xs text-[var(--muted)]">
        Chỉ áp dụng cho quẹt từ <strong>ứng dụng di động</strong>. Máy chấm công cố
        định không bị kiểm tra — nó được lắp cố định và không gửi toạ độ.
      </p>

      {error && <Alert tone="danger">{error}</Alert>}

      {result && (
        <>
          <Alert
            tone={
              result.errors.length > 0 || result.sitesWithoutFence.length > 0
                ? 'warn'
                : result.byStatus.REJECTED > 0
                  ? 'warn'
                  : 'info'
            }
          >
            <p>
              Đã kiểm tra <strong>{result.checked}</strong> quẹt ·{' '}
              {Object.entries(result.byStatus)
                .filter(([, n]) => n > 0)
                .map(([k, n]) => `${LABEL[k as GeoStatus]} ${n}`)
                .join(' · ') || 'không có quẹt nào'}
            </p>
          </Alert>

          {result.sitesWithoutFence.length > 0 && (
            <Alert tone="warn">
              <strong>
                {result.sitesWithoutFence.length} địa điểm có quẹt nhưng CHƯA vẽ
                hàng rào:
              </strong>{' '}
              {result.sitesWithoutFence.join(', ')}. Đây là việc của người quản trị
              — vào <code>/policies/GEOFENCE</code> để thêm. Không phải lỗi của
              người lao động.
            </Alert>
          )}

          {result.byStatus.REJECTED > 0 && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
              <div className="text-sm font-medium">
                Quẹt bị từ chối theo nhân viên ({result.byStatus.REJECTED} quẹt)
              </div>
              <ul className="mt-2 space-y-1 text-sm">
                {result.rejectedByEmployee.slice(0, 15).map((e) => (
                  <li key={e.employeeCode} className="flex justify-between gap-4">
                    <span className="font-mono text-xs">{e.employeeCode}</span>
                    <span className="text-[var(--muted)]">{e.count} quẹt</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-[var(--muted)]">
                "Từ chối" nghĩa là quẹt không đủ điều kiện về vị trí, KHÔNG tự động
                xoá công. Nhân sự vẫn quyết định cuối cùng.
              </p>
            </div>
          )}

          {result.errors.length > 0 && (
            <Alert tone="danger">
              {result.errors.length} lỗi khi kiểm tra: {result.errors[0]}
            </Alert>
          )}
        </>
      )}
    </div>
  );
}
