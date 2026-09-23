/**
 * POST /api/auth/login
 *
 * Trả access token trong BODY (để client gắn vào Authorization header) và
 * refresh token trong COOKIE HttpOnly.
 *
 * Vì sao tách đôi:
 *   - Access token phải đọc được bằng JS thì mới gắn vào header được. Nó sống
 *     15 phút nên bị lộ qua XSS cũng chỉ có 15 phút.
 *   - Refresh token KHÔNG BAO GIỜ được JS đọc (HttpOnly) — đó là thứ sống 14
 *     ngày. Để nó trong body nghĩa là một lỗ XSS lấy được phiên 14 ngày.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { login, checkRateLimit, AuthError } from '@/lib/auth';
import { extractClientIp } from '@/engine/workflow';
import { refreshCookie, sessionCookie } from '@/lib/cookies';

export const dynamic = 'force-dynamic';

/**
 * Hai cookie: `refresh_token` (Path=/api/auth, 14 ngày) và `access_token`
 * (Path=/, 15 phút) cho các trang RSC.
 *
 * Phải dùng `Headers.append` chứ không phải object: một object chỉ giữ được MỘT
 * giá trị cho cùng một tên header, nên cookie thứ hai sẽ âm thầm ghi đè cookie
 * thứ nhất — và lỗi đó không hiện ở đâu cả, chỉ thấy "đăng nhập xong vào trang
 * vẫn bị đẩy về /login".
 */
function authCookies(refresh: string, access: string, secure: boolean): Headers {
  const h = new Headers();
  h.append('Set-Cookie', refreshCookie(refresh, 14, secure));
  h.append('Set-Cookie', sessionCookie(access, 900, secure));
  return h;
}

export async function POST(req: Request) {
  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  const ip = extractClientIp(headers);
  const db = getDb();

  // Giới hạn theo IP: 10 lần / phút. Theo IP chứ không theo tên đăng nhập —
  // nếu khoá theo tên đăng nhập thì kẻ tấn công chỉ cần gõ sai mật khẩu của
  // nạn nhân để khoá nạn nhân ra khỏi hệ thống.
  const rl = await checkRateLimit(`login:${ip}`, 10, 60_000, db);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED', message: 'Quá nhiều lần thử. Vui lòng chờ.' } },
      { status: 429, headers: { 'Retry-After': String(Math.ceil(rl.retryAfterMs / 1000)) } },
    );
  }

  let body: { username?: string; password?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_JSON', message: 'Body không phải JSON hợp lệ.' } },
      { status: 400 },
    );
  }

  if (!body.username || !body.password) {
    return NextResponse.json(
      { error: { code: 'MISSING_FIELD', message: 'Thiếu username hoặc password.' } },
      { status: 400 },
    );
  }

  try {
    const result = await login(body.username, body.password, { ip, userAgent: headers['user-agent'] }, db);
    const secure = new URL(req.url).protocol === 'https:';
    return NextResponse.json(
      {
        user: result.user,
        accessToken: result.accessToken,
        // expiresIn để client biết khi nào cần làm mới, thay vì đoán.
        expiresIn: 900,
      },
      { headers: authCookies(result.refreshToken, result.accessToken, secure) },
    );
  } catch (e) {
    const code = e instanceof AuthError ? e.code : 'AUTH_FAILED';
    // 401 cho sai thông tin, 423 (Locked) cho tài khoản bị khoá — hai tình
    // huống cần hai cách xử lý khác nhau ở client.
    const status = code === 'ACCOUNT_LOCKED' ? 423 : code === 'ACCOUNT_DISABLED' ? 403 : 401;
    return NextResponse.json(
      { error: { code, message: e instanceof Error ? e.message : String(e) } },
      { status },
    );
  }
}
