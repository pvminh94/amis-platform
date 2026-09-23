/** POST /api/auth/logout — thu hồi CẢ HỌ token, không chỉ token hiện tại. */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { logout } from '@/lib/auth';
import { clearRefreshCookie, readCookie } from '@/lib/cookies';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = readCookie(req, 'refresh_token');
  const revoked = token ? await logout(token, getDb()) : 0;
  return NextResponse.json(
    { revoked },
    {
      headers: {
        'Set-Cookie': clearRefreshCookie(),
      },
    },
  );
}
