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
import { refreshCookie } from '../login/route';

export const dynamic = 'force-dynamic';

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

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
      { headers: { 'Set-Cookie': refreshCookie(result.refreshToken, 14, secure) } },
    );
  } catch (e) {
    const code = e instanceof AuthError ? e.code : 'REFRESH_FAILED';
    // TOKEN_REUSED trả 401 và XOÁ cookie — phiên này không cứu được nữa.
    const clear = 'refresh_token=; HttpOnly; Path=/api/auth; Max-Age=0; SameSite=Lax';
    return NextResponse.json(
      { error: { code, message: e instanceof Error ? e.message : String(e) } },
      { status: 401, headers: { 'Set-Cookie': clear } },
    );
  }
}
