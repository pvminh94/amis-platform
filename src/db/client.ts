/**
 * Kết nối PostgreSQL thật qua node-postgres + Drizzle.
 *
 * KHÔNG dùng in-memory mock ở bất kỳ đâu: migration, seed, test đều chạy trên
 * PostgreSQL thật. Lý do — mock che giấu đúng những thứ dễ sai nhất (kiểu cột,
 * ràng buộc UNIQUE, CHECK, EXCLUDE). Bài học này trả giá bằng hai lần deploy
 * hỏng trên VPS.
 */
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let db: Db | null = null;

export function getDb(): Db {
  if (!db) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL chưa được đặt. Sao chép .env.example thành .env rồi điền URL PostgreSQL.',
      );
    }
    pool = new Pool({ connectionString: url, max: 10 });
    db = drizzle(pool, { schema });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
