/**
 * Cookie chứa refresh token.
 *
 * NẰM Ở ĐÂY CHỨ KHÔNG PHẢI TRONG route.ts: Next.js chỉ cho phép một file route
 * handler export đúng một vài tên (GET, POST, dynamic, config…). Export thêm một
 * hàm tiện ích là lỗi build, và lỗi này chỉ hiện khi `.next/types` đã được sinh
 * — tức là `tsc` chạy tay có thể xanh trong khi `npm run verify` đỏ.
 */

/** HttpOnly + SameSite=Lax + Secure khi chạy HTTPS. Path hẹp để cookie không gửi kèm mọi request. */
export function refreshCookie(token: string, maxAgeDays = 14, secure = true): string {
  return [
    `refresh_token=${token}`,
    'HttpOnly',
    'Path=/api/auth',
    `Max-Age=${maxAgeDays * 86_400}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Cookie xoá — dùng khi đăng xuất hoặc khi phát hiện tái sử dụng token. */
export function clearRefreshCookie(): string {
  return 'refresh_token=; HttpOnly; Path=/api/auth; Max-Age=0; SameSite=Lax';
}

/**
 * Cookie phiên cho CÁC TRANG (RSC), chứa access token.
 *
 * Vì sao phải có cookie THỨ HAI trong khi đã có `refresh_token`:
 *
 *   `refresh_token` cố ý đặt `Path=/api/auth` để nó không bị gửi kèm mọi request
 *   — thu hẹp phạm vi rò rỉ. Nhưng chính vì vậy mà trình duyệt KHÔNG gửi nó tới
 *   `/payroll`, nên trang không có cách nào biết người xem là ai. Kết quả là mọi
 *   trang RSC đọc thẳng DB và render mà không kiểm tra phiên: ai biết URL đều đọc
 *   được bảng lương. Lỗ hổng này không lộ ra ở tầng API (API vẫn đòi
 *   `Authorization`) nên test API xanh hết trong khi trang thì hở.
 *
 *   Nên: refresh token giữ path hẹp, còn access token đi thêm một cookie `Path=/`
 *   để trang kiểm được. Access token sống 15 phút nên phạm vi phơi bày ngắn, và
 *   nó là JWT ký bằng secret của server — không thể tự tạo.
 *
 * HttpOnly: JavaScript không đọc được, nên XSS không lấy cắp được nó. API vẫn
 * dùng header `Authorization` như cũ, nên cookie này không mở thêm mặt CSRF cho
 * API (các trang chỉ có GET đọc dữ liệu).
 */
export function sessionCookie(token: string, maxAgeSeconds = 15 * 60, secure = true): string {
  return [
    `access_token=${token}`,
    'HttpOnly',
    'Path=/',
    `Max-Age=${maxAgeSeconds}`,
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Xoá cookie phiên — khi đăng xuất. */
export function clearSessionCookie(): string {
  return 'access_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax';
}

/** Tên cookie phiên — một chỗ duy nhất để middleware và trang cùng dùng. */
export const SESSION_COOKIE = 'access_token';

/** Đọc một cookie từ header. Trả null nếu không có. */
export function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
