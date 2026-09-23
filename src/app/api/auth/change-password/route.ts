/**
 * POST /api/auth/change-password — đổi mật khẩu.
 *
 * Đây là lối ra duy nhất cho cờ `mustChangePassword`. Thiếu nó thì mọi tài khoản
 * do admin tạo bị chặn khỏi toàn bộ hệ thống vĩnh viễn.
 *
 * Yêu cầu access token còn hiệu lực NHƯNG cho phép phiên đang bị ép đổi mật khẩu
 * — đó là điểm duy nhất cờ `allowMustChangePassword` được bật.
 */

import { NextResponse } from 'next/server';
import { changePassword, AuthError } from '@/lib/auth';
import { authenticate, authErrorResponse } from '@/lib/rbac';
import { getDb } from '@/db/client';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, number> = {
  WRONG_PASSWORD: 401,
  WEAK_PASSWORD: 422,
  SAME_PASSWORD: 422,
  USER_NOT_FOUND: 401,
};

export async function POST(req: Request) {
  let principal;
  try {
    principal = await authenticate(req, getDb(), { allowMustChangePassword: true });
  } catch (e) {
    return authErrorResponse(e);
  }

  let body: { currentPassword?: string; newPassword?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: { code: 'BAD_REQUEST', message: 'Body phải là JSON' } },
      { status: 400 },
    );
  }

  if (!body.currentPassword || !body.newPassword) {
    return NextResponse.json(
      {
        error: { code: 'BAD_REQUEST', message: 'Cần currentPassword và newPassword' },
      },
      { status: 400 },
    );
  }

  try {
    const r = await changePassword(
      principal.claims.sub,
      body.currentPassword,
      body.newPassword,
      getDb(),
    );
    // Thu hồi mọi phiên nên access token hiện tại vẫn còn hiệu lực tới hết TTL,
    // nhưng refresh token đã chết — client bắt buộc đăng nhập lại. Nói rõ điều
    // đó thay vì để client tự đoán vì sao lần refresh kế tiếp thất bại.
    return NextResponse.json({
      changed: true,
      revokedSessions: r.revokedSessions,
      mustReLogin: true,
    });
  } catch (e) {
    if (e instanceof AuthError) {
      return NextResponse.json(
        { error: { code: e.code, message: e.message } },
        { status: STATUS[e.code] ?? 400 },
      );
    }
    throw e;
  }
}
