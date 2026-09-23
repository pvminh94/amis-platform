/**
 * ============================================================================
 * CHẠY THỬ QUY TRÌNH DUYỆT END-TO-END
 * ============================================================================
 *
 * Chạy: npm run demo:approval   (cần `npm run payroll` trước)
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, getPool, closeDb } = await import('../src/db/client.js');
const { approvalRequests, approvalAudit, payRuns } = await import('../src/db/schema.js');
const {
  submitApproval,
  actOnApproval,
  submitPayRunForApproval,
  syncPayRunStatus,
  actionsFor,
} = await import('../src/lib/approval.js');
const { eq, sql } = await import('drizzle-orm');

const db = getDb();
const fmt = (n: number) => n.toLocaleString('vi-VN');

console.log('\n' + '═'.repeat(78));
console.log('  QUY TRÌNH DUYỆT — ngưỡng là dữ liệu, máy trạng thái là code');
console.log('═'.repeat(78) + '\n');

// Script này CHẠY LẠI ĐƯỢC mà không cần dọn dẹp.
//
// Bản trước dọn bằng `DELETE FROM approval_requests`, và vì approval_audit có
// FK ON DELETE CASCADE nên lệnh đó kéo theo việc xoá bản ghi audit — đúng thứ
// mà trigger bất biến cấm. Hệ quả: demo chạy được MỘT lần, lần thứ hai nổ ngay
// ở dòng dọn dẹp. Lỗi không phải ở trigger (nó đang làm đúng việc) mà ở chỗ demo
// tự cho phép mình phá thứ nó vừa chứng minh là không phá được.
//
// Cách sửa: mỗi lần chạy dùng docRef mới. Không đụng tới lịch sử đã ghi.
const newId = () => crypto.randomUUID();

// --- 1. Đơn chi nhiều cấp --------------------------------------------------
const EXPENSE_ID = newId();
const sub = await submitApproval({
  docType: 'EXPENSE',
  docRef: EXPENSE_ID,
  docLabel: 'Đề nghị thanh toán mua thiết bị',
  value: 300_000_000,
  context: { amount: 300_000_000, category: 'CAPEX' },
  actor: 'nv0001',
});
console.log(`[1] Đơn chi 300.000.000đ → chính sách ${sub.policy}`);
console.log(`    Chuỗi ${sub.chain.length} bước: ${sub.chain.map((c) => c.name).join(' → ')}`);
console.log(`    Chuỗi này được CHỤP vào đơn, không đọc lại từ chính sách mỗi lần.`);

const walk = async (requestId: string, approvers: Array<[string, string]>) => {
  for (const [i, [who, role]] of approvers.entries()) {
    const [req] = await db
      .select()
      .from(approvalRequests)
      .where(eq(approvalRequests.id, requestId))
      .limit(1);
    const allowed = actionsFor(req!.state);
    console.log(
      `    bước ${i + 1}/${req!.totalSteps} · ${req!.state} · được phép: [${allowed.join(', ')}]`,
    );
    const r = await actOnApproval({
      requestId,
      action: 'APPROVE',
      actorId: who,
      actorName: who,
      actorRole: role,
      comment: `Duyệt bước ${i + 1}`,
      ipAddress: '10.0.0.' + (i + 2),
    });
    console.log(`      ✓ ${who} (${role}) → ${r.state}${r.finished ? '  [KẾT THÚC]' : ''}`);
  }
};

await walk(sub.requestId, [
  ['dm01', 'DIRECT_MANAGER'],
  ['dh01', 'DEPT_HEAD'],
  ['kt01', 'CHIEF_ACCOUNTANT'],
  ['ceo1', 'CEO'],
]);

// --- 2. Hành động phi pháp phải bị chặn ------------------------------------
console.log('\n[2] Đơn đã APPROVED, thử REJECT:');
try {
  await actOnApproval({
    requestId: sub.requestId,
    action: 'REJECT',
    actorId: 'ceo1',
    ipAddress: '10.0.0.9',
  });
  console.log('    ✗ LỖI: đáng lẽ phải bị chặn');
} catch (e) {
  console.log(`    ✓ bị chặn — ${(e as Error).message.slice(0, 90)}`);
}

// --- 3. Duyệt thiếu người phải bị chặn -------------------------------------
console.log('\n[3] APPROVE mà không có người thực hiện:');
const EXP2 = newId();
const sub2 = await submitApproval({
  docType: 'EXPENSE',
  docRef: EXP2,
  docLabel: 'Đơn chi nhỏ',
  value: 3_000_000,
  actor: 'nv0002',
});
try {
  await actOnApproval({
    requestId: sub2.requestId,
    action: 'APPROVE',
    actorId: null,
    ipAddress: '10.0.0.9',
  });
  console.log('    ✗ LỖI: đáng lẽ phải bị chặn');
} catch (e) {
  console.log(`    ✓ bị chặn — ${(e as Error).message.slice(0, 70)}`);
}

// --- 4. Một tài liệu không thể có hai đơn ----------------------------------
console.log('\n[4] Nộp lại đúng đơn chi đó lần nữa:');
try {
  await submitApproval({
    docType: 'EXPENSE',
    docRef: EXPENSE_ID,
    docLabel: 'Trùng',
    value: 300_000_000,
    actor: 'nv0001',
  });
  console.log('    ✗ LỖI: đáng lẽ phải bị chặn');
} catch (e) {
  console.log(`    ✓ bị chặn — ${(e as Error).message.slice(0, 70)}`);
}

// --- 5. Loại chứng từ chưa cấu hình phải dừng lại ---------------------------
console.log('\n[5] Loại chứng từ chưa cấu hình ngưỡng:');
try {
  await submitApproval({
    docType: 'KHONG_CO_LUAT',
    docRef: newId(),
    docLabel: 'X',
    value: 1,
    actor: 'nv0001',
  });
  console.log('    ✗ LỖI: đáng lẽ phải bị chặn');
} catch (e) {
  console.log(`    ✓ bị chặn — ${(e as Error).message.slice(0, 80)}`);
}

// --- 6. Kỳ lương ----------------------------------------------------------
console.log('\n[6] Nộp bảng lương ra duyệt:');
const [run] = await db
  .select()
  .from(payRuns)
  .where(eq(payRuns.status, 'DRAFT'))
  .limit(1);
if (run) {
  const pr = await submitPayRunForApproval(run.id, 'kt01');
  console.log(
    `    ${pr.chain.length} bước: ${pr.chain.map((c) => c.name).join(' → ')} (thực nhận ${fmt(run.netTotal)}đ)`,
  );
  await actOnApproval({
    requestId: pr.requestId,
    action: 'APPROVE',
    actorId: 'kt01',
    actorName: 'Kế toán trưởng',
    actorRole: 'CHIEF_ACCOUNTANT',
    ipAddress: '10.0.0.20',
  });
  await syncPayRunStatus(run.id, 'APPROVED');
  const [after] = await db.select({ s: payRuns.status }).from(payRuns).where(eq(payRuns.id, run.id));
  console.log(`    ✓ kỳ lương chuyển sang ${after!.s}`);
} else {
  console.log('    (không còn kỳ DRAFT — chạy lại npm run payroll)');
}

// --- 7. Audit trail bất biến ----------------------------------------------
console.log('\n[7] Audit trail — thử sửa một bản ghi:');
const pool = getPool();
try {
  await pool.query(`UPDATE approval_audit SET comment = 'đã sửa' WHERE id = (SELECT id FROM approval_audit LIMIT 1)`);
  console.log('    ✗ LỖI: đáng lẽ trigger phải chặn');
} catch (e) {
  console.log(`    ✓ trigger chặn — ${((e as Error).message.split('\n')[0] ?? '').slice(0, 70)}`);
}
try {
  await pool.query(`DELETE FROM approval_audit WHERE id = (SELECT id FROM approval_audit LIMIT 1)`);
  console.log('    ✗ LỖI: đáng lẽ trigger phải chặn');
} catch (e) {
  console.log(`    ✓ trigger chặn — ${((e as Error).message.split('\n')[0] ?? '').slice(0, 70)}`);
}

const trail = await db
  .select()
  .from(approvalAudit)
  .where(eq(approvalAudit.requestId, sub.requestId));
console.log(`\n[8] Dấu vết của đơn chi 300 triệu (${trail.length} bản ghi, không sửa được):`);
for (const a of trail) {
  console.log(
    `    ${a.at.toISOString().slice(11, 19)}  ${String(a.action).padEnd(8)} ${a.fromStatus} → ${String(a.toStatus).padEnd(16)} ${(a.actorId ?? '-').padEnd(7)} ${a.ipAddress}`,
  );
}

console.log('\n');
await closeDb();
