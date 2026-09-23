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
