/** POST /api/auth/logout — thu hồi CẢ HỌ token, không chỉ token hiện tại. */

import { NextResponse } from 'next/server';
import { getDb } from '@/db/client';
import { logout } from '@/lib/auth';

export const dynamic = 'force-dynamic';

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get('cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export async function POST(req: Request) {
  const token = readCookie(req, 'refresh_token');
  const revoked = token ? await logout(token, getDb()) : 0;
  return NextResponse.json(
    { revoked },
    {
      headers: {
        'Set-Cookie': 'refresh_token=; HttpOnly; Path=/api/auth; Max-Age=0; SameSite=Lax',
      },
    },
  );
}
