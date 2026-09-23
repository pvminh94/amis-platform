/**
 * GET /api/health — điểm kiểm tra sống cho Docker HEALTHCHECK và load balancer.
 *
 * KHÔNG đòi quyền: health check không đăng nhập được. Nhưng cũng vì thế nó
 * KHÔNG được tiết lộ gì ngoài "sống" hay "chết" — không số phiên bản, không
 * thông báo lỗi của PostgreSQL. Một endpoint công khai mà kể ra "connection
 * refused tới 10.0.3.2:5432" là đang vẽ bản đồ mạng hộ người dò.
 *
 * Có ping DB chứ không chỉ trả 200. Lý do: một container Next.js vẫn trả 200
 * cho trang tĩnh khi DB đã chết, và HEALTHCHECK chỉ đo "Next có sống không"
 * thì sẽ báo xanh trong khi không ai đăng nhập hay xem được bảng lương nào.
 */

import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';

import { getDb } from '@/db/client';

export const dynamic = 'force-dynamic';

export async function GET() {
  let dbOk = false;
  let migrations = 0;
  try {
    const db = getDb();
    // Hai câu hỏi trong một lần nối: DB có trả lời không, và schema đã migrate
    // tới đâu. `drizzle.__drizzle_migrations` không tồn tại nghĩa là app đang
    // chạy trên một DB CHƯA migrate — tình huống mà compose hay gặp nhất khi
    // service migrate chưa chạy xong.
    await db.execute(sql`select 1`);
    const r = await db.execute(
      sql`select count(*)::int as n from drizzle.__drizzle_migrations`,
    );
    migrations = (r as unknown as { rows: { n: number }[] }).rows[0]?.n ?? 0;
    dbOk = true;
  } catch {
    dbOk = false;
  }

  if (!dbOk) {
    return NextResponse.json({ status: 'degraded', database: 'unreachable' }, { status: 503 });
  }
  if (migrations === 0) {
    return NextResponse.json(
      { status: 'degraded', database: 'ok', migrations: 0, hint: 'chưa migrate' },
      { status: 503 },
    );
  }

  return NextResponse.json({ status: 'ok', database: 'ok', migrations });
}
