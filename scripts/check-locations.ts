/**
 * ============================================================================
 * KIỂM TRA VỊ TRÍ QUẸT THẺ THEO GEOFENCE
 * ============================================================================
 *
 * Chạy: npm run check:locations            (cả tháng 09/2026)
 *       npm run check:locations 2026-09-01 2026-09-15
 *
 * Ghi ngược kết quả vào raw_punches.geo_status. Chạy lại được nhiều lần — mỗi
 * lần đánh giá lại theo hàng rào đang hiệu lực TẠI NGÀY CỦA QUẸT.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { validatePunchLocations, geoStatusCounts } = await import('../src/lib/location-check.js');
const { sql } = await import('drizzle-orm');

const from = process.argv[2] ?? '2026-09-01';
const to = process.argv[3] ?? '2026-09-30';

const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log(`  KIỂM TRA VỊ TRỊ QUẸT THẺ — ${from} → ${to}`);
console.log('═'.repeat(78) + '\n');

const r = await validatePunchLocations(db, { from, to });

console.log(`  Đã kiểm tra ${r.checked} quẹt từ thiết bị MOBILE\n`);
for (const [status, n] of Object.entries(r.byStatus)) {
  const pct = r.checked ? ((n / r.checked) * 100).toFixed(1) : '0.0';
  const bar = '█'.repeat(Math.round((n / Math.max(1, r.checked)) * 40));
  console.log(`    ${status.padEnd(9)} ${String(n).padStart(5)}  ${pct.padStart(5)}%  ${bar}`);
}

if (r.sitesWithoutFence.length > 0) {
  console.log(
    `\n  ⚠ Địa điểm CÓ quẹt nhưng CHƯA cấu hình hàng rào: ${r.sitesWithoutFence.join(', ')}`,
  );
  console.log('    Đây là việc của người quản trị, KHÔNG phải lỗi của người lao động.');
}

if (r.rejectedByEmployee.length > 0) {
  console.log('\n  Quẹt bị TỪ CHỐI theo nhân viên:');
  for (const e of r.rejectedByEmployee.slice(0, 12)) {
    console.log(`    ${e.employeeCode.padEnd(8)} ${e.count} quẹt`);
  }
}

if (r.errors.length > 0) {
  console.log(`\n  ✗ ${r.errors.length} lỗi khi kiểm tra:`);
  for (const e of r.errors.slice(0, 5)) console.log(`    ${e}`);
}

// --- Phân bố lý do từ chối ---------------------------------------------------
const reasons = await db.execute(
  sql`select reason, count(*)::int as n
      from raw_punches, jsonb_array_elements_text(geo_reasons) as reason
      where punched_at >= ${from}::date and punched_at < (${to}::date + 1)
      group by 1 order by 2 desc`,
);
const rrows = (reasons as unknown as { rows: { reason: string; n: number }[] }).rows;
if (rrows.length > 0) {
  console.log('\n  Lý do từ chối (một quẹt có thể có nhiều lý do):');
  for (const x of rrows) console.log(`    ${x.reason.padEnd(22)} ${x.n}`);
}

const counts = await geoStatusCounts(db, from, to);
console.log('\n  Toàn bộ quẹt trong kỳ (kể cả từ máy cố định):');
for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(18)} ${v}`);

console.log('');
await closeDb();
