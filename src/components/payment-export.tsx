'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert } from '@/components/ui';
import { api } from '@/lib/client-token';

/**
 * Xuất lô thanh toán cho một kỳ lương.
 *
 * Chọn NGÂN HÀNG (mã tham số), không chọn định dạng: định dạng là thuộc tính của
 * tham số ngân hàng đã khai trong Policy Registry. Thêm một ngân hàng mới là thêm
 * một dòng dữ liệu, không phải sửa component này.
 *
 * Kết quả luôn hiện cả ba danh sách thiếu/chưa-đối-chiếu/cảnh-báo, kể cả khi xuất
 * thành công. Một file gửi ngân hàng "thành công" nhưng thiếu một người là chuyện
 * phải thấy ngay trên màn hình, không phải lúc đối chiếu cuối tháng.
 */
export function PaymentExport({ payRunId }: { payRunId: string }) {
  const router = useRouter();
  const [regime, setRegime] = useState('BANK_VCB');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    batchId: string;
    batchNo: string;
    fileName: string;
    rowCount: number;
    totalAmount: number;
    checksum: string;
    missing: { employeeCode: string; fullName: string; netPay: number }[];
    unverified: { employeeCode: string; accountNumber: string }[];
    warnings: string[];
  } | null>(null);

  const fmt = (n: number) => n.toLocaleString('vi-VN');

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api(`/api/pay-runs/${payRunId}/payment-file`, {
        method: 'POST',
        json: { regimeCode: regime },
      });
      const data = (await res.json()) as {
        batchId?: string;
        error?: { code?: string; message?: string };
      } & Record<string, unknown>;
      if (!res.ok || !data.batchId) {
        setError(
          data.error?.code === 'FORBIDDEN'
            ? 'Bạn không có quyền xuất file thanh toán (cần payment:export).'
            : (data.error?.message ?? `Lỗi ${res.status}`),
        );
        return;
      }
      setResult(data as unknown as NonNullable<typeof result>);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!result) return;
    // Đi qua `api()` để kèm Bearer token — thẻ <a download> trần không gắn được
    // header Authorization nên sẽ nhận về 401.
    void (async () => {
      const res = await api(`/api/payment-batches/${result.batchId}/download`, { method: 'GET' });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setError(d.error?.message ?? `Không tải được (HTTP ${res.status})`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = result.fileName;
      a.click();
      URL.revokeObjectURL(url);
    })();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          Ngân hàng
          <select
            value={regime}
            onChange={(e) => setRegime(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--fg)]"
          >
            <option value="BANK_VCB">Vietcombank (txt định dạng cố định)</option>
            <option value="BANK_TCB">Techcombank (CSV)</option>
            <option value="BANK_CTG">VietinBank (CSV)</option>
            <option value="BANK_MBB">MB Bank (CSV)</option>
          </select>
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={run}
          className="rounded-md border border-[var(--accent-dim)] px-4 py-2 text-sm text-[var(--accent)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          {busy ? '…' : 'Xuất file'}
        </button>
      </div>

      {error && <Alert tone="danger">{error}</Alert>}

      {result && (
        <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] p-3 text-sm">
          <div className="font-mono text-xs">
            {result.fileName} · {result.rowCount} món ·{' '}
            <strong>{fmt(result.totalAmount)} đ</strong>
          </div>
          <div className="font-mono text-[11px] text-[var(--muted)]">
            SHA-256 {result.checksum}
          </div>
          <button
            type="button"
            onClick={download}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:bg-[var(--surface)]"
          >
            Tải file
          </button>

          {result.missing.length > 0 && (
            <Alert tone="danger">
              {result.missing.length} người KHÔNG có trong file vì thiếu tài khoản ngân hàng —
              số tiền này CHƯA được trả:{' '}
              {result.missing
                .map((m) => `${m.employeeCode} ${fmt(m.netPay)} đ`)
                .join(', ')}
            </Alert>
          )}
          {result.unverified.length > 0 && (
            <Alert tone="warn">
              {result.unverified.length} tài khoản chưa đối chiếu với ngân hàng:{' '}
              {result.unverified.map((u) => `${u.employeeCode} (${u.accountNumber})`).join(', ')}.
              Chuyển tiền vào số chưa đối chiếu là lỗi không sửa được sau khi gửi.
            </Alert>
          )}
          <button
            type="button"
            onClick={() => router.refresh()}
            className="text-xs text-[var(--accent)] underline"
          >
            Làm mới danh sách lô
          </button>
        </div>
      )}
    </div>
  );
}
