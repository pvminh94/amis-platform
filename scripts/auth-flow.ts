/**
 * ============================================================================
 * CHẠY THỬ TOÀN BỘ LUỒNG XÁC THỰC + RBAC
 * ============================================================================
 *
 * Chạy: npm run demo:auth   (cần `npm run seed:auth` trước)
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { users, refreshTokens, rateLimitBuckets } = await import('../src/db/schema.js');
const {
  login,
  refreshSession,
  logout,
  loadAuthority,
  canAccessRow,
  widestScope,
  checkRateLimit,
  pruneExpiredTokens,
  revokeAllSessions,
  AuthError,
} = await import('../src/lib/auth.js');
const { verifyAccessToken } = await import('../src/engine/auth.js');
const { eq, sql } = await import('drizzle-orm');

const db = getDb();
const PW = 'Amis@2026!';
const META = { ip: '10.0.0.7', userAgent: 'demo-script' };

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (ok) {
    pass++;
    console.log(`    ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail++;
    console.log(`    ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
};
const codeOf = async (fn: () => Promise<unknown>): Promise<string> => {
  try {
    await fn();
    return '(không ném)';
  } catch (e) {
    return e instanceof AuthError ? e.code : `(${String(e).slice(0, 60)})`;
  }
};

console.log('\n' + '═'.repeat(78));
console.log('  XÁC THỰC + RBAC');
console.log('═'.repeat(78) + '\n');

// Dọn trạng thái khoá và rate limit từ lần chạy trước
await db.execute(sql`UPDATE users SET failed_attempts = 0, locked_until = NULL`);
await db.execute(sql`DELETE FROM rate_limit_buckets`);

console.log('[1] Đăng nhập');
const s1 = await login('hr.admin', PW, META, db);
check('đăng nhập đúng mật khẩu', s1.user.username === 'hr.admin');
check('access token verify được', (await verifyAccessToken(s1.accessToken)).ok);
check('roles lấy từ DB', s1.user.roles.includes('HR_ADMIN'), s1.user.roles.join(','));
check('cờ bắt buộc đổi mật khẩu', s1.user.mustChangePassword === true);

console.log('\n[2] Thông báo lỗi cố tình mơ hồ — chống liệt kê tài khoản');
const wrongPw = await codeOf(() => login('hr.admin', 'sai-mat-khau', META, db));
const noUser = await codeOf(() => login('khong-ton-tai', 'sai-mat-khau', META, db));
check('sai mật khẩu → INVALID_CREDENTIALS', wrongPw === 'INVALID_CREDENTIALS', wrongPw);
check('tài khoản không tồn tại → CÙNG mã lỗi', noUser === wrongPw, noUser);

console.log('\n[3] Khoá tài khoản sau 5 lần sai');
await db.execute(sql`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username='nv.kythuat'`);
for (let i = 1; i <= 5; i++) {
  const c = await codeOf(() => login('nv.kythuat', 'sai', META, db));
  if (i === 5) check(`lần ${i} → ACCOUNT_LOCKED`, c === 'ACCOUNT_LOCKED', c);
}
const afterLock = await codeOf(() => login('nv.kythuat', PW, META, db));
check('đúng mật khẩu vẫn bị chặn khi đang khoá', afterLock === 'ACCOUNT_LOCKED', afterLock);
await db.execute(sql`UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE username='nv.kythuat'`);

console.log('\n[4] Xoay vòng refresh token');
const s2 = await refreshSession(s1.refreshToken, META, db);
check('refresh cho token mới', s2.refreshToken !== s1.refreshToken);
check('cùng một họ token', s2.familyId === s1.familyId);
const oldAfterRotate = await codeOf(() => refreshSession(s1.refreshToken, META, db));
check(
  'dùng lại token cũ → TOKEN_REUSED, thu hồi cả họ',
  oldAfterRotate === 'TOKEN_REUSED',
  oldAfterRotate,
);
const thirdGen = await codeOf(() => refreshSession(s2.refreshToken, META, db));
check('token đời sau cũng bị thu hồi theo họ', thirdGen === 'TOKEN_REUSED', thirdGen);

console.log('\n[5] Đăng xuất thu hồi cả họ');
const s3 = await login('kt.truong', PW, META, db);
const before = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(refreshTokens)
  .where(eq(refreshTokens.userId, s3.user.id));
const n = await logout(s3.refreshToken, db);
check('thu hồi ít nhất 1 token', n >= 1, `${n} token`);
const after = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(refreshTokens)
  .where(sql`${refreshTokens.userId} = ${s3.user.id} AND ${refreshTokens.revokedAt} IS NULL`);
check('không còn token hiệu lực nào', (after[0]?.n ?? -1) === 0);
void before;

console.log('\n[6] RBAC — quyền theo vai trò');
const [hr] = await db.select().from(users).where(eq(users.username, 'hr.admin')).limit(1);
const [emp] = await db.select().from(users).where(eq(users.username, 'nv.kythuat')).limit(1);
const [dh] = await db.select().from(users).where(eq(users.username, 'tp.kythuat')).limit(1);
const hrAuth = await loadAuthority(hr!.id, db);
const empAuth = await loadAuthority(emp!.id, db);
const dhAuth = await loadAuthority(dh!.id, db);
check('HR_ADMIN có payroll:run', hrAuth.permissions.has('payroll:run'));
check('HR_ADMIN KHÔNG có user:manage', !hrAuth.permissions.has('user:manage'));
// ĐÃ SỬA: assertion này viết ở Phase 9, còn Phase 14 đã thêm attendance:read cho
// EMPLOYEE (nhân viên xem chấm công CỦA MÌNH, phạm vi SELF chặn phần còn lại) mà
// không cập nhật ở đây. Cùng một assertion cũ nằm ở CẢ HAI demo script — đó là lý
// do nó đỏ âm thầm mấy phase liền mà không ai thấy: không có chỗ nào chạy cả hai.
// So ĐÚNG TẬP QUYỀN, không so số lượng.
const empPerms = [...empAuth.permissions].sort();
check(
  'EMPLOYEE có đúng {attendance:read, print:read}',
  JSON.stringify(empPerms) === JSON.stringify(['attendance:read', 'print:read']),
  empPerms.join(', '),
);
check('DEPT_HEAD có approval:act', dhAuth.permissions.has('approval:act'));

console.log('\n[7] Phạm vi dữ liệu — cùng quyền, khác dữ liệu được thấy');
const rows = [
  { department: 'Kỹ thuật', branch: null, ownerId: emp!.id },
  { department: 'Kế toán', branch: null, ownerId: 'khac' },
];
check('DEPT_HEAD Kỹ thuật thấy phòng Kỹ thuật', canAccessRow(dhAuth.scopes, rows[0]!, dh!.id));
check('DEPT_HEAD Kỹ thuật KHÔNG thấy phòng Kế toán', !canAccessRow(dhAuth.scopes, rows[1]!, dh!.id));
check('HR_ADMIN (COMPANY) thấy mọi phòng', canAccessRow(hrAuth.scopes, rows[1]!, hr!.id));
check('EMPLOYEE (SELF) chỉ thấy hàng của mình', canAccessRow(empAuth.scopes, rows[0]!, emp!.id));
check('EMPLOYEE (SELF) không thấy hàng người khác', !canAccessRow(empAuth.scopes, rows[1]!, emp!.id));
check('phạm vi rộng nhất của DEPT_HEAD là DEPARTMENT', widestScope(dhAuth.scopes).level === 'DEPARTMENT');

console.log('\n[8] Rate limit trong database');
for (let i = 0; i < 4; i++) await checkRateLimit('demo:bucket', 5, 60_000, db);
const rl5 = await checkRateLimit('demo:bucket', 5, 60_000, db);
const rl6 = await checkRateLimit('demo:bucket', 5, 60_000, db);
check('lần 5 vẫn được phép', rl5.allowed);
check('lần 6 bị chặn', !rl6.allowed, `còn ${rl6.remaining}`);
const stored = await db.select().from(rateLimitBuckets).where(eq(rateLimitBuckets.bucketKey, 'demo:bucket'));
check('bucket nằm trong DB, không phải bộ nhớ', stored.length === 1);

console.log('\n[9] Dọn dẹp không được xoá token còn hiệu lực');
// Phải TẠO token hiệu lực trước đã. Lần chạy đầu check này báo "còn 0" — đúng
// nhưng vô nghĩa, vì không có gì để mà xoá nhầm. Một assertion so 0 với 0 thì
// xanh kể cả khi hàm xoá sạch cả bảng.
const fresh = await login('admin', PW, META, db);
const validBefore = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(refreshTokens)
  .where(sql`${refreshTokens.revokedAt} IS NULL`);
check('có token hiệu lực để kiểm tra', validBefore[0]!.n >= 1, `${validBefore[0]!.n} token`);
const deleted = await pruneExpiredTokens(db);
const validAfter = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(refreshTokens)
  .where(sql`${refreshTokens.revokedAt} IS NULL`);
check(
  'pruneExpiredTokens không đụng token còn hiệu lực',
  deleted === 0 && validAfter[0]!.n === validBefore[0]!.n,
  `xoá ${deleted}, còn ${validAfter[0]!.n}/${validBefore[0]!.n}`,
);
const stillWorks = await refreshSession(fresh.refreshToken, META, db);
check('token vừa được dọn vẫn refresh được', stillWorks.user.username === 'admin');

console.log('\n[10] Thu hồi mọi phiên khi nghi ngờ lộ');
const s4 = await login('admin', PW, META, db);
const revoked = await revokeAllSessions(s4.user.id, db);
check('thu hồi được ít nhất 1 phiên', revoked >= 1, `${revoked} phiên`);
check(
  'refresh sau đó thất bại',
  (await codeOf(() => refreshSession(s4.refreshToken, META, db))) === 'TOKEN_REUSED',
);

console.log(`\n${'─'.repeat(78)}`);
console.log(`  ${pass} đạt · ${fail} hỏng`);
console.log('─'.repeat(78) + '\n');
await closeDb();
if (fail > 0) process.exit(1);
