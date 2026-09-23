/**
 * ============================================================================
 * Content-Security-Policy
 * ============================================================================
 *
 * Nằm ở ĐÂY chứ không phải trong middleware.ts: middleware chỉ được export
 * `middleware` và `config`, thêm tên khác là lỗi build. Và tách ra thì test mới
 * gọi thẳng được — xem tests/csp.spec.ts.
 *
 * BUG ĐÃ SỬA: bản cũ đặt cứng `script-src 'self'` cho MỌI môi trường. Nghe thì
 * đúng ("không cho inline script" là chính sách tốt), nhưng `next dev` bơm 11 thẻ
 * <script> inline vào trang và mở một WebSocket tới HMR. Cả hai bị chặn, nên:
 *
 *     React không hydrate được  ->  nút bấm không gắn được handler
 *                               ->  bấm nút Đăng nhập KHÔNG CÓ GÌ XẢY RA
 *
 * Trang vẫn render đẹp vì đó là HTML phía server, và `curl` thì KHÔNG chạy
 * JavaScript nên mọi lần kiểm tra bằng curl đều XANH. Lỗi chỉ hiện khi có người
 * thật mở trình duyệt và bấm — tức là 824 test xanh trong khi sản phẩm không dùng
 * được ở bước đầu tiên.
 *
 * Production giữ nguyên chính sách chặt: `next build` không sinh inline script nên
 * không cần nới. Chỉ dev mới nới, và nới CÓ GIỚI HẠN.
 *
 * `isDev` là THAM SỐ chứ không đọc `process.env.NODE_ENV` trực tiếp trong hàm:
 * bundler thay thế tĩnh `process.env.NODE_ENV` thành hằng số lúc biên dịch, nên
 * một hàm đọc trực tiếp sẽ không thể test được ở cả hai nhánh.
 */

export function buildCsp(isDev: boolean = process.env.NODE_ENV !== 'production'): string {
  return [
    "default-src 'self'",
    isDev
      ? // 'unsafe-eval' cho webpack dev middleware, 'unsafe-inline' cho các thẻ
        // script Next.js bơm thẳng vào HTML, ws:/wss: cho kênh HMR.
        "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
      : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // blob: cần cho ảnh tải về qua URL.createObjectURL (nút tải file ngân hàng).
    "font-src 'self' data: blob:",
    isDev ? "connect-src 'self' ws: wss:" : "connect-src 'self'",
    // Ba dòng dưới KHÔNG bao giờ nới, kể cả trong dev.
    "frame-ancestors 'none'", // chống clickjacking
    "base-uri 'self'", // chống chèn <base> để chuyển hướng relative URL
    "form-action 'self'", // chống form POST sang domain khác
  ].join('; ');
}
