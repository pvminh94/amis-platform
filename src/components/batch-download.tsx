'use client';

/**
 * Nút "tải" cho một lô thanh toán đã lập.
 *
 * Vì sao phải là client component chứ không phải một thẻ <a href> trần:
 *
 *   Endpoint `/api/payment-batches/[id]/download` xác thực bằng header
 *   `Authorization: Bearer`, còn thẻ <a href> chỉ gửi được COOKIE. Nên bấm vào
 *   thẻ <a> là nhận về trang JSON `401 UNAUTHORIZED` thay vì file — và người dùng
 *   không hiểu tại sao, vì "nút tải" trông hoàn toàn bình thường.
 *
 *   Lỗi này ĐÃ được ghi chú trong payment-export.tsx nhưng bảng lịch sử ở
 *   /payments vẫn dùng thẻ <a>. Hai chỗ làm cùng một việc theo hai cách, và chỉ
 *   một cách đúng.
 *
 *   Cách sửa KHÔNG phải là nới endpoint cho nhận cookie: file thanh toán là thứ
 *   nhạy cảm nhất trong hệ thống, và cho phép tải nó bằng cookie là mở mặt CSRF
 *   đúng chỗ tệ nhất. Đúng ra là client phải đính kèm token như mọi API khác.
 */

import { AuthDownload } from '@/components/auth-download';

/**
 * Nút "tải" cho một lô thanh toán đã lập. Chỉ là AuthDownload với tên file lấy từ
 * lô — tách ra để /payments và /payroll/[id] gọi cùng một chỗ.
 */
export function BatchDownload({ batchId, fileName }: { batchId: string; fileName: string }) {
  return (
    <AuthDownload
      href={`/api/payment-batches/${batchId}/download`}
      fileName={fileName}
      label="tải"
    />
  );
}
