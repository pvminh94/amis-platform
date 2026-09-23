/**
 * ============================================================================
 * DEMO — THANH TOÁN NGÂN HÀNG qua HTTP THẬT
 * ============================================================================
 *
 * Chạy: npm run demo:payment
 *   (cần dev server ở cổng 3100, npm run seed:all và npm run payroll trước)
 *
 * Khác với demo:auth / demo:rbac (gọi thẳng tầng service), script này gọi QUA
 * HTTP: route handler là code mới và chưa từng được thực thi, mà phần lớn rủi ro
 * của một route nằm ở chính những thứ service không nhìn thấy — map lỗi sang mã
 * HTTP, validate body, header tải file. Gọi service trực tiếp thì bỏ qua hết.
 *
 * Token được ký thẳng từ dòng user trong DB (như demo:rbac) thay vì đi qua
 * đăng nhập: luồng đổi mật khẩu đã có demo:auth lo, còn ở đây cần một phiên hợp
 * lệ để kiểm tra QUYỀN, không phải để kiểm tra mật khẩu.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { signAccessToken } = await import('../src/engine/auth.js');
const { users, userRoles, roles, bankPaymentBatches, payRuns } = await import(
  '../src/db/schema.js'
);
const { eq, desc } = await import('drizzle-orm');

const BASE = process.env.DEMO_BASE_URL ?? 'http://127.0.0.1:3100';
const db = getDb();

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++;
    console.log(`    ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function tokenFor(username: string): Promise<string> {
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!u) throw new Error(`seed chưa có ${username} — chạy npm run seed:auth`);
  const rs = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, u.id));
  return signAccessToken({
    sub: u.id,
    username: u.username,
    roles: rs.map((r) => r.code),
    mustChangePassword: false,
  });
}

async function call(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
): Promise<{
  status: number;
  headers: Headers;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  bytes: () => Promise<Buffer>;
}> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    headers: res.headers,
    json: () => res.json(),
    text: () => res.text(),
    // PHẢI đọc byte, không đọc text. `res.text()` giải mã UTF-8 và THEO CHUẨN
    // Encoding sẽ CẮT BOM ở đầu chuỗi. File TCB/CTG/MBB có BOM (ngân hàng yêu
    // cầu để Excel mở không lỗi font), nên bản đầu tiên của đoạn kiểm tra này băm
    // ra một giá trị khác checksum đã ghi — và nếu tin vào nó thì sẽ đi "sửa"
    // một route vốn đang đúng. Kiểm tra tính nguyên vẹn của byte thì phải đo byte.
    bytes: async () => Buffer.from(await res.arrayBuffer()),
  };
}

console.log('\n' + '═'.repeat(78));
console.log('  THANH TOÁN NGÂN HÀNG — gọi qua HTTP thật');
console.log('═'.repeat(78) + '\n');

const [run] = await db.select().from(payRuns).orderBy(desc(payRuns.createdAt)).limit(1);
if (!run) {
  console.error('✗ chưa có kỳ lương — chạy npm run payroll');
  await closeDb();
  process.exit(1);
}
const kt = await tokenFor('kt.truong'); // CHIEF_ACCOUNTANT — CÓ payment:export
const hr = await tokenFor('hr.admin'); // HR_ADMIN — KHÔNG có payment:export
console.log(`  Kỳ lương: ${String(run.periodMonth).padStart(2, '0')}/${run.periodYear} (${run.id})\n`);

// --- 1. Tách nhiệm vụ ------------------------------------------------------
console.log('[1] Phân quyền');
{
  const r = await call(hr, 'POST', `/api/pay-runs/${run.id}/payment-file`, {
    regimeCode: 'BANK_VCB',
  });
  const j = (await r.json()) as { error?: { code?: string } };
  check(
    'HR_ADMIN bị CHẶN khi xuất file thanh toán',
    r.status === 403 && j.error?.code === 'FORBIDDEN',
    `HTTP ${r.status} ${j.error?.code}`,
  );
  // Đây là điểm mấu chốt của thiết kế: người tính lương không phải người chuyển
  // tiền. Nếu HR_ADMIN làm được cả hai thì một tài khoản tự tăng lương cho mình
  // rồi tự chuyển, và không ai phát hiện.
}
{
  const r = await call(null, 'POST', `/api/pay-runs/${run.id}/payment-file`, {
    regimeCode: 'BANK_VCB',
  });
  check('không token → 401', r.status === 401, `HTTP ${r.status}`);
}

// --- 2. Validate -----------------------------------------------------------
console.log('\n[2] Kiểm tra đầu vào');
{
  const r = await call(kt, 'POST', `/api/pay-runs/${run.id}/payment-file`, {
    regimeCode: 'BANK_VCB',
    date: '30/09/2026',
  });
  const j = (await r.json()) as { error?: { code?: string } };
  check('ngày sai định dạng → 400 INVALID_BODY', r.status === 400 && j.error?.code === 'INVALID_BODY', `HTTP ${r.status}`);
}
{
  const r = await call(kt, 'POST', '/api/pay-runs/khong-phai-uuid/payment-file', {
    regimeCode: 'BANK_VCB',
  });
  check(
    'id không phải UUID → 400 chứ không phải 500',
    r.status === 400,
    `HTTP ${r.status} — PostgreSQL sẽ ném 22P02 và ra tới người dùng thành 500 nếu không chặn`,
  );
}
{
  const r = await call(kt, 'POST', '/api/pay-runs/00000000-0000-4000-8000-000000000000/payment-file', {
    regimeCode: 'BANK_VCB',
  });
  check('kỳ không tồn tại → 404', r.status === 404, `HTTP ${r.status}`);
}

// --- 3. Một kỳ một lô ------------------------------------------------------
console.log('\n[3] Chống xuất trùng');
{
  // seed:payment đã tạo một lô VCB chưa VOID cho kỳ này.
  const r = await call(kt, 'POST', `/api/pay-runs/${run.id}/payment-file`, {
    regimeCode: 'BANK_VCB',
  });
  const j = (await r.json()) as { error?: { code?: string; message?: string } };
  check(
    'xuất lại VCB cho cùng kỳ → 409 DUPLICATE_BATCH',
    r.status === 409 && j.error?.code === 'DUPLICATE_BATCH',
    `HTTP ${r.status} ${j.error?.code}`,
  );
}
{
  // Cùng kỳ nhưng NGÂN HÀNG KHÁC thì được — công ty có thể trả qua hai ngân hàng.
  const r = await call(kt, 'POST', `/api/pay-runs/${run.id}/payment-file`, {
    regimeCode: 'BANK_TCB',
  });
  const j = (await r.json()) as { batchNo?: string; rowCount?: number; error?: { message?: string } };
  check(
    'cùng kỳ, ngân hàng KHÁC → 201',
    r.status === 201 && !!j.batchNo,
    `HTTP ${r.status} ${j.batchNo ?? j.error?.message}`,
  );
}

// --- 4. Tải file -----------------------------------------------------------
console.log('\n[4] Tải file đã lưu');
{
  const [latest] = await db
    .select({ id: bankPaymentBatches.id, fileName: bankPaymentBatches.fileName, checksum: bankPaymentBatches.checksum })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.payRunId, run.id))
    .orderBy(desc(bankPaymentBatches.generatedAt))
    .limit(1);

  const r = await call(kt, 'GET', `/api/payment-batches/${latest!.id}/download`);
  const body = await r.bytes();
  check('tải file → 200', r.status === 200, `HTTP ${r.status}, ${body.length} byte`);
  check(
    'header Content-Disposition có tên file',
    (r.headers.get('content-disposition') ?? '').includes(latest!.fileName),
    r.headers.get('content-disposition') ?? '(không có)',
  );
  check(
    'Content-Length khớp số byte THẬT đã nhận',
    r.headers.get('content-length') === String(body.length),
    `${r.headers.get('content-length')} vs ${body.length}`,
  );
  // File CSV phải mở được bằng Excel mà không lỗi font tiếng Việt — đó là lý do
  // có BOM. Thiếu BOM thì file vẫn "đúng" về dữ liệu nhưng người dùng thấy rác.
  check(
    'file CSV có BOM UTF-8 (EF BB BF)',
    body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf,
    body.subarray(0, 3).toString('hex'),
  );

  const { createHash } = await import('node:crypto');
  const actual = createHash('sha256').update(body).digest('hex');
  check(
    'SHA-256 của nội dung tải về khớp checksum đã ghi lúc xuất',
    actual === latest!.checksum,
    actual === latest!.checksum ? actual.slice(0, 16) + '…' : `${actual.slice(0, 12)} ≠ ${latest!.checksum.slice(0, 12)}`,
  );

  const anon = await call(null, 'GET', `/api/payment-batches/${latest!.id}/download`);
  check('tải file không token → 401', anon.status === 401, `HTTP ${anon.status}`);
}

// --- 5. Máy trạng thái -----------------------------------------------------
console.log('\n[5] Trạng thái lô');
{
  const [b] = await db
    .select({ id: bankPaymentBatches.id })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.payRunId, run.id))
    .orderBy(desc(bankPaymentBatches.generatedAt))
    .limit(1);

  const bad = await call(kt, 'POST', `/api/payment-batches/${b!.id}/status`, {
    status: 'RETURNED',
  });
  check(
    'GENERATED → RETURNED bị từ chối (chưa gửi sao bị trả)',
    bad.status === 409,
    `HTTP ${bad.status}`,
  );

  const sent = await call(kt, 'POST', `/api/payment-batches/${b!.id}/status`, { status: 'SENT' });
  check('GENERATED → SENT → 200', sent.status === 200, `HTTP ${sent.status}`);

  const back = await call(kt, 'POST', `/api/payment-batches/${b!.id}/status`, {
    status: 'RETURNED',
    returnedCount: 1,
    notes: 'ngân hàng trả 1 món',
  });
  check('SENT → RETURNED → 200', back.status === 200, `HTTP ${back.status}`);

  // Dọn dẹp: huỷ lô TCB vừa tạo để seed:payment chạy lại được.
  await call(kt, 'POST', `/api/payment-batches/${b!.id}/status`, { status: 'VOID', notes: 'demo' });
  const afterVoid = await call(kt, 'POST', `/api/payment-batches/${b!.id}/status`, {
    status: 'SENT',
  });
  check('VOID là trạng thái cuối — không quay lại SENT', afterVoid.status === 409, `HTTP ${afterVoid.status}`);
}

console.log(
  `\n${'─'.repeat(78)}\n  ${pass} đạt / ${fail} hỏng\n${'─'.repeat(78)}\n`,
);
await closeDb();
process.exit(fail === 0 ? 0 : 1);
