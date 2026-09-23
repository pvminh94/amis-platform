/**
 * ============================================================================
 * SEED NHÂN VIÊN — bước phải chạy TRƯỚC chấm công và TRƯỚC tính lương
 * ============================================================================
 *
 * Chạy: npm run seed:employees
 *
 * Tách khỏi run-payroll.ts để phá một vòng phụ thuộc: seed:attendance cần nhân
 * viên (khoá ngoại), mà nhân viên lại do payroll tạo, payroll lại cần chấm công.
 * Vòng đó khiến `npm run seed:all` trên một DB trắng không có thứ tự nào đúng.
 *
 * Idempotent: UPSERT theo employeeCode. Không DELETE — raw_punches trỏ vào
 * employees bằng ON DELETE RESTRICT, và RESTRICT ở đó là cố ý: xoá một nhân viên
 * không được kéo theo bằng chứng chấm công của họ.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { employees } = await import('../src/db/schema.js');
const { ROSTER } = await import('./roster.js');

const db = getDb();

console.log('\n' + '═'.repeat(78));
console.log('  SEED NHÂN VIÊN');
console.log('═'.repeat(78) + '\n');

for (const e of ROSTER) {
  await db
    .insert(employees)
    .values({ ...e, active: true })
    .onConflictDoUpdate({
      target: employees.employeeCode,
      set: {
        fullName: e.fullName,
        department: e.department,
        wageRegion: e.wageRegion,
        trainedWorker: e.trainedWorker,
        dependents: e.dependents,
        baseSalary: e.baseSalary,
        hourlyRate: e.hourlyRate,
        active: true,
      },
    });
}

const depts = new Set(ROSTER.map((e) => e.department));
const regions = new Set(ROSTER.map((e) => e.wageRegion));
console.log(`  ✓ ${ROSTER.length} nhân viên — ${depts.size} bộ phận, ${regions.size} vùng lương`);
console.log(`    lương cơ bản ${Math.min(...ROSTER.map((e) => e.baseSalary)).toLocaleString('vi-VN')}` +
  ` → ${Math.max(...ROSTER.map((e) => e.baseSalary)).toLocaleString('vi-VN')} đ`);
console.log('    (khoảng rộng đủ để trần BHXH 20× và sàn BHTN có tác dụng)\n');

await closeDb();
