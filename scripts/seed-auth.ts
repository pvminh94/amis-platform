/**
 * ============================================================================
 * SEED VAI TRÒ, QUYỀN, NGƯỜI DÙNG
 * ============================================================================
 *
 * Chạy: npm run seed:auth
 * Mật khẩu seed: Amis@2026!  (mọi tài khoản, mustChangePassword = true)
 */

import { readFileSync } from 'node:fs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const { users, roles, permissions, rolePermissions, userRoles, refreshTokens } = await import(
  '../src/db/schema.js'
);
const { hashPassword } = await import('../src/engine/auth.js');
const { eq, sql } = await import('drizzle-orm');

const db = getDb();
const SEED_PASSWORD = 'Amis@2026!';

console.log('\n' + '═'.repeat(78));
console.log('  VAI TRÒ + QUYỀN + PHẠM VI DỮ LIỆU');
console.log('═'.repeat(78) + '\n');

// --- Quyền -----------------------------------------------------------------
const PERMISSIONS = [
  ['policy:read', 'Xem chính sách'],
  ['policy:write', 'Soạn phiên bản chính sách'],
  ['policy:activate', 'Kích hoạt phiên bản chính sách'],
  ['payroll:read', 'Xem bảng lương'],
  ['payroll:run', 'Chạy tính lương'],
  ['payroll:submit', 'Nộp bảng lương ra duyệt'],
  ['approval:act', 'Duyệt / từ chối đơn'],
  ['report:read', 'Chạy báo cáo'],
  ['report:write', 'Soạn định nghĩa báo cáo'],
  ['print:read', 'Xem và in mẫu'],
  ['print:write', 'Soạn mẫu in'],
  ['employee:read', 'Xem nhân viên'],
  ['employee:write', 'Thêm / sửa nhân viên'],
  ['user:manage', 'Quản trị người dùng và vai trò'],
] as const;

// --- Vai trò ---------------------------------------------------------------
const ROLES = [
  {
    code: 'ADMIN',
    nameVi: 'Quản trị hệ thống',
    isSystem: true,
    perms: PERMISSIONS.map((p) => p[0]),
  },
  {
    code: 'HR_ADMIN',
    nameVi: 'Nhân sự',
    isSystem: false,
    perms: [
      'policy:read', 'policy:write', 'payroll:read', 'payroll:run', 'payroll:submit',
      'report:read', 'report:write', 'print:read', 'print:write', 'employee:read', 'employee:write',
    ],
  },
  {
    code: 'CHIEF_ACCOUNTANT',
    nameVi: 'Kế toán trưởng',
    isSystem: false,
    perms: ['policy:read', 'payroll:read', 'payroll:submit', 'approval:act', 'report:read', 'print:read'],
  },
  {
    code: 'DEPT_HEAD',
    nameVi: 'Trưởng phòng',
    isSystem: false,
    perms: ['payroll:read', 'approval:act', 'report:read', 'employee:read'],
  },
  {
    code: 'EMPLOYEE',
    nameVi: 'Nhân viên',
    isSystem: false,
    perms: ['print:read'],
  },
] as const;

// --- Người dùng ------------------------------------------------------------
const PEOPLE = [
  { username: 'admin', fullName: 'Quản trị hệ thống', roles: ['ADMIN'], scope: 'COMPANY', value: null },
  { username: 'hr.admin', fullName: 'Trần Nhân Sự', roles: ['HR_ADMIN'], scope: 'COMPANY', value: null },
  { username: 'kt.truong', fullName: 'Lê Kế Toán', roles: ['CHIEF_ACCOUNTANT'], scope: 'COMPANY', value: null },
  { username: 'tp.kythuat', fullName: 'Phạm Kỹ Thuật', roles: ['DEPT_HEAD'], scope: 'DEPARTMENT', value: 'Kỹ thuật' },
  { username: 'tp.ketoan', fullName: 'Võ Kế Toán Phòng', roles: ['DEPT_HEAD'], scope: 'DEPARTMENT', value: 'Kế toán' },
  { username: 'nv.kythuat', fullName: 'Nguyễn Kỹ Thuật', roles: ['EMPLOYEE'], scope: 'SELF', value: null },
] as const;

await db.execute(sql`DELETE FROM refresh_tokens`);
await db.execute(sql`DELETE FROM user_roles`);
await db.execute(sql`DELETE FROM role_permissions`);
await db.execute(sql`DELETE FROM users`);
await db.execute(sql`DELETE FROM roles`);
await db.execute(sql`DELETE FROM permissions`);

const permIds = new Map<string, string>();
for (const [code, nameVi] of PERMISSIONS) {
  const [r] = await db.insert(permissions).values({ code, nameVi }).returning({ id: permissions.id });
  permIds.set(code, r!.id);
}
console.log(`[1] ✓ ${PERMISSIONS.length} quyền`);

const roleIds = new Map<string, string>();
for (const r of ROLES) {
  const [row] = await db
    .insert(roles)
    .values({ code: r.code, nameVi: r.nameVi, isSystem: r.isSystem })
    .returning({ id: roles.id });
  roleIds.set(r.code, row!.id);
  for (const p of r.perms) {
    await db.insert(rolePermissions).values({ roleId: row!.id, permissionId: permIds.get(p)! });
  }
  console.log(`    ${r.code.padEnd(17)} ${r.perms.length} quyền`);
}
console.log(`[2] ✓ ${ROLES.length} vai trò`);

const hash = await hashPassword(SEED_PASSWORD);
for (const p of PEOPLE) {
  const [u] = await db
    .insert(users)
    .values({
      username: p.username,
      passwordHash: hash,
      fullName: p.fullName,
      mustChangePassword: true,
    })
    .returning({ id: users.id });
  for (const rc of p.roles) {
    await db.insert(userRoles).values({
      userId: u!.id,
      roleId: roleIds.get(rc)!,
      scopeLevel: p.scope,
      scopeValue: p.value,
    });
  }
  console.log(`    ${p.username.padEnd(13)} ${p.roles.join(',').padEnd(17)} phạm vi ${p.scope}${p.value ? ` = ${p.value}` : ''}`);
}
console.log(`[3] ✓ ${PEOPLE.length} người dùng — mật khẩu seed '${SEED_PASSWORD}', bắt buộc đổi ở lần đầu`);

console.log(`\n    npm run demo:auth để chạy thử toàn bộ luồng\n`);
await closeDb();
