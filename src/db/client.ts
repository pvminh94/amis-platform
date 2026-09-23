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

/**
 * Pool thô, cho những query cần THAM SỐ HOÁ ĐỘNG.
 *
 * Drizzle giỏi ở chỗ biết schema — nhưng engine báo cáo ghép SQL từ một định
 * nghĩa JSON lúc chạy, nên nó không có schema để Drizzle dùng. Vẫn phải đi qua
 * pool để giá trị được bind đúng cách ($1, $2…), chứ không phải nối chuỗi.
 */
export function getPool(): Pool {
  getDb(); // đảm bảo pool đã được tạo
  if (!pool) throw new Error('Pool chưa được khởi tạo.');
  return pool;
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    db = null;
  }
}
