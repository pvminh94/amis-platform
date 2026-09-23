/**
 * Chốt đích chuyển hướng sau đăng nhập.
 *
 * `/login?next=...` là chỗ kinh điển nhất để mở một lỗ open redirect: người dùng
 * đã quen bấm qua trang đăng nhập nên không đọc URL, và một link
 * `/login?next=https://evil.com` trông hoàn toàn vô hại.
 */

/**
 * Trả về đích an toàn. Chỉ chấp nhận đường dẫn TUYỆT ĐỐI TRONG SITE.
 *
 * Ba trường hợp phải chặn, và cả ba đều dễ bỏ sót:
 *   `https://evil.com`  → không bắt đầu bằng `/`, bị loại ngay.
 *   `//evil.com`        → BẮT ĐẦU bằng `/` nhưng là protocol-relative URL,
 *                         trình duyệt hiểu thành "tới evil.com". Đây là cái
 *                         nguy hiểm nhất vì nó qua được kiểm tra `startsWith('/')`.
 *   `/\\evil.com`       → một số trình duyệt đổi `\` thành `/`, thành `//evil.com`.
 *
 * Không hợp lệ thì trả `/`, KHÔNG ném lỗi: người dùng bấm link hỏng nên được đưa
 * về trang chủ, không phải nhận một trang báo lỗi.
 */
export function safeRedirectTarget(next: string | null | undefined): string {
  if (!next) return '/';

  // Chặn protocol-relative và biến thể dùng backslash TRƯỚC khi kiểm tra `/`.
  if (next.startsWith('//') || next.startsWith('/\\')) return '/';

  if (!next.startsWith('/')) return '/';

  // Đã là đường dẫn trong site. Chặn luôn việc nhúng URL đầy đủ vào query,
  // vd `/redirect?url=https://evil.com` — không phải việc của hàm này, nhưng một
  // khoảng trắng hay ký tự điều khiển nối vào thì có.
  if (/[\s\u0000-\u001f]/.test(next)) return '/';

  return next;
}
