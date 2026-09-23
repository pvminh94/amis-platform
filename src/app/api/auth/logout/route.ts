/** POST /api/auth/logout — thu hồi CẢ HỌ token, không chỉ token hiện tại. */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { logout } from '@/lib/auth';
import { clearRefreshCookie, clearSessionCookie, readCookie } from '@/lib/cookies';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const token = readCookie(req, 'refresh_token');
  const revoked = token ? await logout(token, getDb()) : 0;
  return NextResponse.json(
    { revoked },
    {
      headers: (() => {
        const h = new Headers();
        h.append('Set-Cookie', clearRefreshCookie());
        h.append('Set-Cookie', clearSessionCookie());
        return h;
      })(),
    },
  );
}
