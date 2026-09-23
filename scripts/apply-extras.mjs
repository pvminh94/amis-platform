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
  const cons = await client.query(`
    SELECT conname, contype FROM pg_constraint
    WHERE conname = 'excl_policy_active_overlap'
  `);
  if (cons.rowCount === 1) {
    console.log('✓ EXCLUDE constraint excl_policy_active_overlap đã áp dụng');
  } else {
    console.error('✗ Không tìm thấy constraint sau khi chạy');
    process.exit(1);
  }
} finally {
  await client.end();
}
