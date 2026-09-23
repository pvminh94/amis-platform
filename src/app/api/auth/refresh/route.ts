/**
 * POST /api/auth/refresh — đổi refresh token (từ cookie) lấy cặp token mới.
 *
 * Cookie mới được ghi đè: xoay vòng token nghĩa là token cũ chết ngay sau khi
 * dùng, và nếu client không nhận cookie mới thì lần refresh kế tiếp sẽ kích
 * hoạt phát hiện tái sử dụng.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { refreshSession, AuthError } from '@/lib/auth';
import { extractClientIp } from '@/engine/workflow';
import { refreshCookie, sessionCookie, clearRefreshCookie, clearSessionCookie, readCookie } from '@/lib/cookies';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = readCookie(req, 'refresh_token');
  if (!token) {
    return NextResponse.json(
      { error: { code: 'NO_TOKEN', message: 'Không có refresh token.' } },
      { status: 401 },
    );
  }

  const headers: Record<string, string | undefined> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });

  try {
    const result = await refreshSession(token, {
      ip: extractClientIp(headers),
      userAgent: headers['user-agent'],
    });
    const secure = new URL(req.url).protocol === 'https:';
    return NextResponse.json(
      { user: result.user, accessToken: result.accessToken, expiresIn: 900 },
      {
        headers: (() => {
          // Làm mới access token thì PHẢI cấp lại cookie phiên, không thì trang
          // RSC hết hạn sau 15 phút trong khi API vẫn chạy — người dùng đang làm
          // việc thì bị đá về /login giữa chừng.
          const h = new Headers();
          h.append('Set-Cookie', refreshCookie(result.refreshToken, 14, secure));
          h.append('Set-Cookie', sessionCookie(result.accessToken, 900, secure));
          return h;
        })(),
      },
    );
  } catch (e) {
    const code = e instanceof AuthError ? e.code : 'REFRESH_FAILED';
    // TOKEN_REUSED trả 401 và XOÁ cookie — phiên này không cứu được nữa.
    // Xoá CẢ HAI cookie: để sót cookie phiên thì trang vẫn mở được trong 15 phút
    // sau khi phiên đã bị thu hồi vì tái sử dụng token.
    const clear = [clearRefreshCookie(), clearSessionCookie()];
    return NextResponse.json(
      { error: { code, message: e instanceof Error ? e.message : String(e) } },
      {
        status: 401,
        headers: clear.reduce((h, c) => (h.append('Set-Cookie', c), h), new Headers()),
      },
    );
  }
}
