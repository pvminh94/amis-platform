/**
 * ============================================================================
 * DEMO — RBAC: ai được làm gì, và vì sao
 * ============================================================================
 *
 * Chạy: npm run demo:rbac
 *
 * Gọi thẳng tầng service (không cần dev server đang chạy) — cùng những hàm mà
 * route handler gọi, nên kết quả đúng với hành vi thật của API.
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { signAccessToken } = await import('../src/engine/auth.js');
const { authenticate, requirePermission, AccessError, bearerToken, authErrorResponse } =
  await import('../src/lib/rbac.js');
const { users, userRoles, roles } = await import('../src/db/schema.js');
const { eq } = await import('drizzle-orm');

type EngineError = { code?: string; message: string; status?: number };

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

/** Lấy userId + roles thật từ DB, rồi ký một access token cho người đó. */
async function tokenFor(username: string, mustChangePassword = false): Promise<string> {
  const [u] = await db.select().from(users).where(eq(users.username, username)).limit(1);
  if (!u) throw new Error(`seed chưa có người dùng ${username} — chạy npm run seed:auth`);
  const rs = await db
    .select({ code: roles.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, u.id));
  return signAccessToken({
    sub: u.id,
    username: u.username,
    roles: rs.map((r) => r.code),
    mustChangePassword,
  });
}

function req(token?: string): Request {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new Request('http://localhost/api/test', { headers });
}

console.log('\n' + '═'.repeat(78));
console.log('  RBAC — quyền đọc từ database tại thời điểm yêu cầu, không từ token');
console.log('═'.repeat(78) + '\n');

// --- 1. Danh tính -----------------------------------------------------------
console.log('[1] Danh tính');
const kt = await tokenFor('kt.truong');
const hr = await tokenFor('hr.admin');

const p1 = await authenticate(req(kt), db);
check('token hợp lệ → xác minh được', p1.claims.username === 'kt.truong', p1.claims.username);

try {
  await authenticate(req(), db);
  check('không có token → phải ném', false);
} catch (e) {
  const err = e as EngineError;
  check('không có token → UNAUTHORIZED', err.code === 'UNAUTHORIZED', String(err.code));
}

try {
  await authenticate(req('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.aaaa'), db);
  check('chữ ký sai → phải ném', false);
} catch (e) {
  check('chữ ký sai → UNAUTHORIZED', (e as EngineError).code === 'UNAUTHORIZED');
}

// --- 2. Phân tách nhiệm vụ --------------------------------------------------
console.log('\n[2] Phân tách nhiệm vụ — người tính lương KHÔNG được ghi sổ');
const hrAuth = await authenticate(req(hr), db);
check(
  'HR_ADMIN có payroll:run',
  hrAuth.authority.permissions.has('payroll:run'),
  'tính được lương',
);
check(
  'HR_ADMIN KHÔNG có gl:post',
  !hrAuth.authority.permissions.has('gl:post'),
  'nhưng không tự ghi sổ được',
);

try {
  await requirePermission(req(hr), 'gl:post', db);
  check('HR_ADMIN ghi sổ → phải bị chặn', false);
} catch (e) {
  const err = e as EngineError;
  check('HR_ADMIN ghi sổ → FORBIDDEN 403', err.code === 'FORBIDDEN' && err.status === 403);
}

const ktAuth = await requirePermission(req(kt), 'gl:post', db);
check(
  'CHIEF_ACCOUNTANT ghi sổ → được',
  ktAuth.authority.permissions.has('gl:post'),
  'kế toán trưởng là người ghi sổ',
);

// --- 3. Cờ bắt buộc đổi mật khẩu -------------------------------------------
console.log('\n[3] Cờ mustChangePassword — chặn mọi thứ trừ việc đổi mật khẩu');
const mcpToken = await tokenFor('kt.truong', true);
try {
  await authenticate(req(mcpToken), db);
  check('phiên mcp → phải bị chặn', false);
} catch (e) {
  check(
    'phiên mcp → MUST_CHANGE_PASSWORD',
    (e as EngineError).code === 'MUST_CHANGE_PASSWORD',
  );
}

// requirePermission KHÔNG có đường vòng
try {
  await requirePermission(req(mcpToken), 'gl:post', db);
  check('requirePermission với phiên mcp → phải bị chặn', false);
} catch (e) {
  check(
    'requirePermission không có đường vòng',
    (e as EngineError).code === 'MUST_CHANGE_PASSWORD',
    'không có tham số nào mở được',
  );
}

// chỉ route đổi mật khẩu mới được đi qua
const p3 = await authenticate(req(mcpToken), db, { allowMustChangePassword: true });
check(
  'allowMustChangePassword → qua được',
  p3.claims.mustChangePassword === true,
  'chỉ route đổi mật khẩu dùng',
);

// --- 4. Quyền đọc từ DB, không từ token -------------------------------------
console.log('\n[4] Token chỉ chứng minh danh tính');
// roles nằm TRONG token, nhưng quyền thì tra DB. Nếu ai đó sửa tay mảng roles
// trong một token tự ký (không thể, vì không có secret) thì cũng không thêm được
// quyền nào — nên kiểm tra ở đây là: quyền đến từ DB.
check(
  'token có roles nhưng quyền tra từ DB',
  p1.authority.permissions.size > 0 && p1.claims.roles.length > 0,
  `${p1.claims.roles.join(',')} → ${p1.authority.permissions.size} quyền`,
);
// ĐÃ SỬA: bản cũ khẳng định "EMPLOYEE chỉ có print:read" và kiểm bằng
// `permissions.size === 1`. Phase 14 đã thêm `attendance:read` cho EMPLOYEE (nhân
// viên xem được chấm công CỦA MÌNH, phạm vi SELF chặn phần còn lại) nhưng không
// cập nhật kiểm tra này — viết từ Phase 9. Nên nó đỏ âm thầm từ Phase 14 tới giờ,
// và không ai biết vì `npm run verify` không chạy demo script.
//
// Sửa thành so ĐÚNG TẬP QUYỀN chứ không so số lượng: `size === 1` sẽ vẫn pass nếu
// ai đó xoá print:read và thêm một quyền hoàn toàn khác — tức là kiểm tra sai mà
// vẫn xanh.
const empPerms = [...(await authenticate(req(await tokenFor('nv.kythuat')), db)).authority.permissions].sort();
check(
  'EMPLOYEE có đúng {attendance:read, print:read}',
  JSON.stringify(empPerms) === JSON.stringify(['attendance:read', 'print:read']),
  empPerms.join(', '),
);
// Và quan trọng hơn số quyền: phạm vi dữ liệu phải là SELF, nếu không
// "xem được chấm công của mình" biến thành "xem được của cả công ty".
const empScopes = (await authenticate(req(await tokenFor('nv.kythuat')), db)).authority.scopes;
check(
  'EMPLOYEE bị giới hạn phạm vi SELF',
  empScopes.length > 0 && empScopes.every((s) => s.level === 'SELF'),
  empScopes.map((s) => s.level).join(',') || '(khong co pham vi)',
);

// --- 5. Header và lỗi --------------------------------------------------------
console.log('\n[5] Đọc header và hình dạng lỗi');
check('Bearer hoa thường đều được', bearerToken(req('x')) === 'x');
check('Basic scheme → null', bearerToken(new Request('http://x', { headers: { authorization: 'Basic abc' } })) === null);

const res = authErrorResponse(new AccessError('FORBIDDEN', 'Thiếu quyền gl:post'));
check('AccessError → 403', res.status === 403);
check('kèm no-store', res.headers.get('cache-control') === 'no-store');

let rethrew = false;
try {
  authErrorResponse(new Error('connection terminated'));
} catch {
  rethrew = true;
}
check(
  'lỗi lạ KHÔNG bị nuốt thành 401',
  rethrew,
  'DB chết phải hiện ra là 500, không phải "hết phiên"',
);

await closeDb();
console.log('\n' + '─'.repeat(78));
console.log(`  ${pass} đạt · ${fail} hỏng`);
console.log('─'.repeat(78) + '\n');
process.exit(fail === 0 ? 0 : 1);
