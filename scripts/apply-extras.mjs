/**
 * Áp dụng src/db/extras.sql — các ràng buộc Drizzle chưa diễn đạt được.
 * Idempotent, chạy được nhiều lần.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// Tự nạp .env — npm scripts KHÔNG tự làm việc này, và quên truyền DATABASE_URL
// là lỗi rất dễ gặp (đã xảy ra khi chạy `npm run verify`).
if (!process.env.DATABASE_URL) {
  const envPath = join(root, '.env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
}
const sql = readFileSync(join(root, 'src', 'db', 'extras.sql'), 'utf8');

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✗ DATABASE_URL chưa được đặt (xem .env.example)');
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();
try {
  await client.query(sql);
  // Kiểm tra CẢ HAI. Chỉ đếm một cái thì cái kia bị xoá cũng không ai biết —
  // và hệ quả là hai biểu thuế cùng hiệu lực mà không có lỗi nào hiện ra.
  const cons = await client.query(`
    SELECT conname FROM pg_constraint
    WHERE conname IN ('excl_policy_active_overlap_by_kind', 'excl_policy_active_overlap_by_code')
    ORDER BY conname
  `);
  const found = cons.rows.map((r) => r.conname);
  const expected = ['excl_policy_active_overlap_by_code', 'excl_policy_active_overlap_by_kind'];
  if (found.join(',') === expected.join(',')) {
    console.log('✓ 2 ràng buộc EXCLUDE đã áp dụng (by_kind + by_code)');
  } else {
    console.error(`✗ Thiếu ràng buộc. Có: ${found.join(', ') || '(không có)'}`);
    process.exit(1);
  }
} finally {
  await client.end();
}
