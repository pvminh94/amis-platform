'use client';

/**
 * Nút tải file cho MỌI endpoint có xác thực.
 *
 * Vì sao không dùng thẻ <a href>: endpoint xác thực bằng header
 * `Authorization: Bearer`, còn thẻ <a> chỉ gửi được cookie. Bấm vào là nhận về
 * trang JSON 401 thay vì file — và "nút tải" vẫn trông hoàn toàn bình thường, nên
 * người dùng không có cách nào hiểu chuyện gì xảy ra.
 *
 * Cách sửa KHÔNG phải là cho endpoint nhận cookie: file lương và file thanh toán
 * ngân hàng là thứ nhạy cảm nhất trong hệ thống, cho phép tải chúng bằng cookie là
 * mở mặt CSRF đúng chỗ tệ nhất. Đúng ra là client đính kèm token như mọi API.
 *
 * `className` truyền vào để nút trông y hệt thẻ <a> cũ — đổi cơ chế tải không được
 * đổi giao diện.
 */

import { useState } from 'react';

import { api } from '@/lib/client-token';

export function AuthDownload({
  href,
  fileName,
  label,
  className,
}: {
  href: string;
  fileName: string;
  label: string;
  className?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onClick = () => {
    setBusy(true);
    setErr(null);
    void (async () => {
      try {
        const res = await api(href, { method: 'GET' });
        if (!res.ok) {
          const d = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
          setErr(d.error?.message ?? `Không tải được (HTTP ${res.status})`);
          return;
        }
        // Đọc bytes chứ không đọc text: file VCB là fixed-width ASCII, còn
        // TCB/CTG/MBB là CSV CÓ BOM, và CSV báo cáo cũng có BOM. `res.text()` lột
        // mất BOM nên file tải về không còn khớp checksum đã lưu trong DB.
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.click();
        // Không revoke ngay: một số trình duyệt huỷ lượt tải nếu URL bị thu hồi
        // trước khi quá trình ghi file kịp bắt đầu.
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    })();
  };

  return (
    <span className="inline-flex flex-col items-start">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className={className ?? 'text-[var(--accent)] underline disabled:opacity-50'}
      >
        {busy ? 'đang tải…' : label}
      </button>
      {/* Hiện lỗi ngay tại nút: lỗi tải mà dồn vào một alert chung thì người dùng
          không biết dòng nào hỏng. */}
      {err && <span className="mt-0.5 text-xs text-[var(--danger)]">{err}</span>}
    </span>
  );
}
