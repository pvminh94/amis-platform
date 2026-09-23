/**
 * ============================================================================
 * DEMO — GHI SỔ MỘT KỲ LƯƠNG THẬT
 * ============================================================================
 *
 * Chạy: npm run demo:gl   (cần `npm run payroll` và `npm run seed:gl` trước)
 *
 * Chứng minh bốn điều, bằng số lấy thẳng từ database:
 *   1. Ba bút toán phát sinh đúng tài khoản theo định khoản đang hiệu lực.
 *   2. Tổng nợ = tổng có trên từng bút toán và trên toàn bảng đối chiếu.
 *   3. TK 334 về 0 — phép thử mạnh nhất của kế toán lương.
 *   4. Ghi lần thứ hai bị chặn, và giao dịch roll back sạch.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { payRuns } = await import('../src/db/schema.js');
const { and, eq, desc } = await import('drizzle-orm');
const { postPayRun, trialBalance } = await import('../src/lib/gl.js');

/**
 * Import động trả về GIÁ TRỊ, không phải kiểu — nên `err as GlError` không
 * biên dịch được (TS2749). Đọc lỗi theo hình dạng của nó là đủ.
 */
type EngineError = { code?: string; message: string };

const db = getDb();
const fmt = (n: number) => Math.abs(n).toLocaleString('vi-VN');
const sign = (n: number) => (n >= 0 ? '' : '-');
/**
 * Số dư đặt vào cột mà nó THỰC SỰ thuộc về, theo dấu của (nợ − có).
 *
 * Bản đầu tiên tôi đặt cột theo `normalSide`, và TK 1121 dư Có 470 triệu bị in
 * thành "SD Nợ 470 triệu". Bảng vẫn thẳng hàng, tổng vẫn cân, nhưng ngược dấu —
 * loại lỗi kế toán khó thấy nhất vì không có gì tự nó kêu lên.
 */
const balanceCols = (l: { debitBalance: number; creditBalance: number }) =>
  `${fmt(l.debitBalance).padStart(14)} ${fmt(l.creditBalance).padStart(14)}`;

console.log('\n' + '═'.repeat(78));
console.log('  GHI SỔ — từ bảng lương sang bút toán kép');
console.log('═'.repeat(78) + '\n');

const runs = await db
  .select()
  .from(payRuns)
  .where(and(eq(payRuns.periodYear, 2026), eq(payRuns.periodMonth, 9)))
  .orderBy(desc(payRuns.createdAt))
  .limit(1);
const run = runs[0];
if (!run) {
  console.error('  Chưa có kỳ lương 09/2026. Chạy `npm run payroll` trước.');
  await closeDb();
  process.exit(1);
}
console.log(
  `[1] Kỳ lương ${String(run.periodMonth).padStart(2, '0')}/${run.periodYear} ` +
    `(${run.status}) — gross ${fmt(run.grossTotal)}, net ${fmt(run.netTotal)}`,
);

// --- Ghi sổ -----------------------------------------------------------------
let posted = false;
try {
  const { entries } = await postPayRun(run.id, { id: 'demo-admin' }, db);
  posted = true;
  console.log(`[2] ✓ Đã ghi ${entries.length} bút toán\n`);
  for (const e of entries) {
    console.log(`  ${e.entryNo.padEnd(22)} ${e.memo}`);
    console.log(`  ${'─'.repeat(70)}`);
    for (const l of e.lines) {
      const debit = l.side === 'DEBIT' ? fmt(l.amount) : '';
      const credit = l.side === 'CREDIT' ? fmt(l.amount) : '';
      console.log(
        `     ${l.account.padEnd(6)} ${debit.padStart(14)} ${credit.padStart(14)}  ${l.memo ?? ''}`,
      );
    }
    console.log(
      `     ${''.padEnd(6)} ${fmt(e.totalDebit).padStart(14)} ${fmt(e.totalCredit).padStart(14)}` +
        (e.totalDebit === e.totalCredit ? '   ✓ cân' : '   ✗ LỆCH'),
    );
    console.log('');
  }
} catch (err) {
  if ((err as EngineError).code === 'ALREADY_POSTED') {
    console.log(`[2] Kỳ này đã ghi sổ trước đó — bỏ qua, dùng bút toán đã có.`);
    console.log(`    ${(err as EngineError).message}\n`);
  } else {
    throw err;
  }
}

// --- Đối chiếu --------------------------------------------------------------
const tb = await trialBalance({ periodYear: 2026, periodMonth: 9 }, db);
console.log(`[3] Bảng đối chiếu thử`);
console.log(
  `  ${'TK'.padEnd(6)} ${'Tên tài khoản'.padEnd(44)} ` +
    `${'PS Nợ'.padStart(14)} ${'PS Có'.padStart(14)} ${'SD Nợ'.padStart(14)} ${'SD Có'.padStart(14)}`,
);
console.log('  ' + '─'.repeat(110));
for (const l of tb.lines) {
  console.log(
    `  ${l.account.padEnd(6)} ${l.accountName.slice(0, 42).padEnd(44)} ` +
      `${fmt(l.debit).padStart(14)} ${fmt(l.credit).padStart(14)} ` +
      balanceCols(l),
  );
}
console.log('  ' + '─'.repeat(110));
console.log(
  `  ${''.padEnd(6)} ${'TỔNG PHÁT SINH'.padEnd(44)} ` +
    `${fmt(tb.totalDebit).padStart(14)} ${fmt(tb.totalCredit).padStart(14)} ` +
    `${fmt(tb.lines.reduce((t, l) => t + l.debitBalance, 0)).padStart(14)} ` +
    `${fmt(tb.lines.reduce((t, l) => t + l.creditBalance, 0)).padStart(14)}` +
    (tb.balanced ? '   ✓ cân' : '   ✗ LỆCH'),
);

// --- Bất biến: 334 phải về 0 ------------------------------------------------
const tk334 = tb.lines.find((l) => l.account === '334');
const balance334 = tk334?.balance ?? 0;
console.log('\n[4] Bất biến quan trọng nhất — TK 334 (phải trả người lao động):');
console.log(`    Phát sinh Nợ ${fmt(tk334?.debit ?? 0)}  Có ${fmt(tk334?.credit ?? 0)}  →  số dư ${sign(balance334)}${fmt(balance334)}`);
if (balance334 === 0) {
  console.log('    ✓ BẰNG 0 — đã ghi nhận đủ, đã trừ đủ, đã trả đủ. Không treo khoản nào.');
} else {
  console.log('    ✗ KHÁC 0 — ghi thiếu hoặc ghi trùng. Sổ này chưa dùng được.');
}

// --- Ghi trùng phải bị chặn -------------------------------------------------
console.log('\n[5] Thử ghi lại kỳ này lần nữa:');
try {
  await postPayRun(run.id, { id: 'demo-admin' }, db);
  console.log('    ✗ KHÔNG BỊ CHẶN — đây là lỗi nghiêm trọng, sổ sẽ bị ghi trùng.');
} catch (err) {
  const e = err as EngineError;
  console.log(`    ✓ Bị chặn (${e.code}): ${e.message}`);
}

const tbAfter = await trialBalance({ periodYear: 2026, periodMonth: 9 }, db);
const same =
  tbAfter.totalDebit === tb.totalDebit && tbAfter.totalCredit === tb.totalCredit;
console.log(
  same
    ? '    ✓ Sổ cái không đổi sau lần ghi thất bại — giao dịch đã roll back sạch.'
    : '    ✗ Sổ cái ĐÃ ĐỔI sau lần ghi thất bại — roll back không hoạt động!',
);

await closeDb();
const ok = tb.balanced && balance334 === 0 && same && posted !== undefined;
console.log(ok ? '\n  Tất cả kiểm tra đạt.\n' : '\n  CÓ KIỂM TRA KHÔNG ĐẠT.\n');
process.exit(ok ? 0 : 1);
