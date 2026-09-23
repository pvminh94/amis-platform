/**
 * ============================================================================
 * XÁC THỰC + RBAC — tầng cần database
 * ============================================================================
 */

import { and, eq, lt, sql } from 'drizzle-orm';
import { getDb, type Db } from '@/db/client';
import {
  permissions,
  rateLimitBuckets,
  refreshTokens,
  rolePermissions,
  roles,
  userRoles,
  users,
} from '@/db/schema';
import {
  checkPasswordStrength,
  generateRefreshToken,
  hashRefreshToken,
  hashPassword,
  signAccessToken,
  verifyPassword,
  REFRESH_TOKEN_TTL_DAYS,
} from '@/engine/auth';

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AuthError';
    this.code = code;
  }
}

/** Khoá tài khoản sau bao nhiêu lần sai mật khẩu, và trong bao lâu. */
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MINUTES = 15;

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  roles: string[];
  mustChangePassword: boolean;
}

export interface LoginResult {
  user: SessionUser;
  accessToken: string;
  refreshToken: string;
  familyId: string;
}

// ---------------------------------------------------------------------------
// RATE LIMIT — trong DATABASE
// ---------------------------------------------------------------------------

/**
 * Giới hạn tốc độ theo cửa sổ cố định.
 *
 * Lưu trong DB chứ không phải bộ nhớ: in-memory reset mỗi lần restart và vô
 * dụng khi chạy nhiều tiến trình. Với một cơ chế an ninh thì "reset khi
 * restart" chính là một lỗ — kẻ tấn công chỉ cần chờ deploy.
 *
 * Trả về false khi vượt ngưỡng. KHÔNG ném, vì người gọi cần tự quyết định trả
 * 429 hay tiếp tục.
 */
export async function checkRateLimit(
  bucketKey: string,
  limit: number,
  windowMs: number,
  db: Db = getDb(),
): Promise<{ allowed: boolean; remaining: number; retryAfterMs: number }> {
  const now = new Date();
  // Cửa sổ cố định theo bucketWindow — làm tròn xuống để mọi request trong cùng
  // một cửa sổ dùng chung một hàng.
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const retryAfterMs = windowStart.getTime() + windowMs - now.getTime();

  // UPSERT: tăng đếm, hoặc tạo hàng mới nếu cửa sổ chưa có.
  await db
    .insert(rateLimitBuckets)
    .values({ bucketKey, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitBuckets.bucketKey, rateLimitBuckets.windowStart],
      set: { count: sql`${rateLimitBuckets.count} + 1` },
    });

  const [row] = await db
    .select({ count: rateLimitBuckets.count })
    .from(rateLimitBuckets)
    .where(
      and(
        eq(rateLimitBuckets.bucketKey, bucketKey),
        eq(rateLimitBuckets.windowStart, windowStart),
      ),
    )
    .limit(1);

  const count = row?.count ?? 1;
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), retryAfterMs };
}

/** Dọn các cửa sổ đã qua — gọi định kỳ, không phải mỗi request. */
export async function pruneRateLimitBuckets(db: Db = getDb()): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000);
  const deleted = await db
    .delete(rateLimitBuckets)
    .where(lt(rateLimitBuckets.windowStart, cutoff))
    .returning({ id: rateLimitBuckets.id });
  return deleted.length;
}

// ---------------------------------------------------------------------------
// ĐĂNG NHẬP
// ---------------------------------------------------------------------------

/**
 * Đăng nhập.
 *
 * THÔNG BÁO LỖI CỐ TÌNH MƠ HỒ: "Sai tên đăng nhập hoặc mật khẩu". Nói rõ
 * "tài khoản không tồn tại" là tặng cho kẻ tấn công một công cụ liệt kê tên
 * đăng nhập hợp lệ.
 *
 * Vẫn băm mật khẩu giả khi tài khoản không tồn tại — nếu không, thời gian phản
 * hồi sẽ khác nhau giữa "không có tài khoản" (nhanh) và "sai mật khẩu" (chậm
 * vì bcrypt), và đó cũng là một cách liệt kê tài khoản.
 */
export async function login(
  username: string,
  password: string,
  meta: { ip: string; userAgent?: string | null },
  db: Db = getDb(),
): Promise<LoginResult> {
  const [user] = await db.select().from(users).where(eq(users.username, username)).limit(1);

  if (!user) {
    // Băm một mật khẩu giả để thời gian phản hồi không phân biệt được.
    await hashPassword(password);
    throw new AuthError('INVALID_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu.');
  }

  if (!user.active) {
    throw new AuthError('ACCOUNT_DISABLED', 'Tài khoản đã bị vô hiệu hoá.');
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new AuthError(
      'ACCOUNT_LOCKED',
      `Tài khoản tạm khoá do nhiều lần nhập sai. Thử lại sau ${mins} phút.`,
    );
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    const failed = user.failedAttempts + 1;
    const shouldLock = failed >= MAX_FAILED_ATTEMPTS;
    await db
      .update(users)
      .set({
        failedAttempts: failed,
        lockedUntil: shouldLock
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
          : user.lockedUntil,
        updatedAt: new Date(),
      })
      .where(eq(users.id, user.id));
    if (shouldLock) {
      throw new AuthError(
        'ACCOUNT_LOCKED',
        `Nhập sai ${MAX_FAILED_ATTEMPTS} lần. Tài khoản tạm khoá ${LOCKOUT_MINUTES} phút.`,
      );
    }
    throw new AuthError('INVALID_CREDENTIALS', 'Sai tên đăng nhập hoặc mật khẩu.');
  }

  // Đăng nhập thành công: reset bộ đếm.
  if (user.failedAttempts > 0) {
    await db
      .update(users)
      .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(users.id, user.id));
  }

  const userRolesRows = await loadUserRoles(user.id, db);
  const session: SessionUser = {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    roles: userRolesRows.map((r) => r.roleCode),
    mustChangePassword: user.mustChangePassword,
  };

  const accessToken = await signAccessToken({
    sub: user.id,
    username: user.username,
    roles: session.roles,
    mustChangePassword: user.mustChangePassword,
  });

  const refreshToken = generateRefreshToken();
  const familyId = crypto.randomUUID();
  await db.insert(refreshTokens).values({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
    ipAddress: meta.ip,
    userAgent: meta.userAgent ?? null,
  });

  await db
    .update(users)
    .set({ lastLoginAt: new Date(), updatedAt: new Date() })
    .where(eq(users.id, user.id));

  return { user: session, accessToken, refreshToken, familyId };
}

// ---------------------------------------------------------------------------
// LÀM MỚI TOKEN — có xoay vòng và phát hiện tái sử dụng
// ---------------------------------------------------------------------------

/**
 * Đổi refresh token lấy cặp token mới.
 *
 * XOAY VÒNG: mỗi lần refresh sinh token mới và thu hồi token cũ. Nếu một token
 * ĐÃ THU HỒI được trình ra lần nữa thì chỉ có hai khả năng: token cũ bị đánh
 * cắp và đang bị dùng song song, hoặc client giữ bản sao cũ. Cả hai đều đáng
 * nghi — nên THU HỒI CẢ HỌ token và bắt đăng nhập lại.
 *
 * Không có phát hiện tái sử dụng thì một refresh token bị lộ sẽ sống suốt 14
 * ngày mà không ai biết.
 */
export async function refreshSession(
  presentedToken: string,
  meta: { ip: string; userAgent?: string | null },
  db: Db = getDb(),
): Promise<LoginResult> {
  const hash = hashRefreshToken(presentedToken);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hash))
    .limit(1);

  if (!row) {
    throw new AuthError('INVALID_TOKEN', 'Refresh token không hợp lệ.');
  }

  // --- TÁI SỬ DỤNG: token đã bị thu hồi mà vẫn được trình ra ---------------
  if (row.revokedAt) {
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.familyId, row.familyId));
    throw new AuthError(
      'TOKEN_REUSED',
      'Refresh token này đã bị thu hồi nhưng vẫn được dùng lại. Toàn bộ phiên ' +
        'trong họ này đã bị thu hồi — vui lòng đăng nhập lại.',
    );
  }

  if (row.expiresAt < new Date()) {
    throw new AuthError('TOKEN_EXPIRED', 'Refresh token đã hết hạn, vui lòng đăng nhập lại.');
  }

  const [user] = await db.select().from(users).where(eq(users.id, row.userId)).limit(1);
  if (!user || !user.active) {
    // Tài khoản bị vô hiệu hoá sau khi đã đăng nhập — phải cắt phiên ngay.
    await db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(eq(refreshTokens.familyId, row.familyId));
    throw new AuthError('ACCOUNT_DISABLED', 'Tài khoản đã bị vô hiệu hoá.');
  }

  const newToken = generateRefreshToken();
  const [inserted] = await db
    .insert(refreshTokens)
    .values({
      userId: user.id,
      tokenHash: hashRefreshToken(newToken),
      familyId: row.familyId,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 86_400_000),
      ipAddress: meta.ip,
      userAgent: meta.userAgent ?? null,
    })
    .returning({ id: refreshTokens.id });

  await db
    .update(refreshTokens)
    .set({ revokedAt: new Date(), replacedBy: inserted!.id })
    .where(eq(refreshTokens.id, row.id));

  const userRolesRows = await loadUserRoles(user.id, db);
  const session: SessionUser = {
    id: user.id,
    username: user.username,
    fullName: user.fullName,
    roles: userRolesRows.map((r) => r.roleCode),
    mustChangePassword: user.mustChangePassword,
  };

  return {
    user: session,
    accessToken: await signAccessToken({
      sub: user.id,
      username: user.username,
      roles: session.roles,
      mustChangePassword: user.mustChangePassword,
    }),
    refreshToken: newToken,
    familyId: row.familyId,
  };
}

/** Đăng xuất: thu hồi CẢ HỌ token, không chỉ token hiện tại. */
export async function logout(presentedToken: string, db: Db = getDb()): Promise<number> {
  const [row] = await db
    .select({ familyId: refreshTokens.familyId })
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, hashRefreshToken(presentedToken)))
    .limit(1);
  if (!row) return 0;
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(eq(refreshTokens.familyId, row.familyId))
    .returning({ id: refreshTokens.id });
  return revoked.length;
}

// ---------------------------------------------------------------------------
// RBAC
// ---------------------------------------------------------------------------

export interface UserAuthority {
  permissions: Set<string>;
  /** Phạm vi rộng nhất mà người dùng có, cho mỗi quyền. */
  scopes: Array<{ level: string; value: string | null }>;
}

async function loadUserRoles(userId: string, db: Db) {
  return db
    .select({ roleCode: roles.code, roleId: roles.id })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
}

/** Toàn bộ quyền của một người dùng, gộp từ mọi vai trò. */
export async function loadAuthority(userId: string, db: Db = getDb()): Promise<UserAuthority> {
  const userRolesRows = await db
    .select({ roleCode: roles.code, permissionCode: permissions.code })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
    .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
    .where(eq(userRoles.userId, userId));

  const scopeRows = await db
    .select({ level: userRoles.scopeLevel, value: userRoles.scopeValue })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));

  return {
    permissions: new Set(userRolesRows.map((r) => r.permissionCode)),
    scopes: scopeRows.map((s) => ({ level: s.level, value: s.value })),
  };
}

const SCOPE_RANK: Record<string, number> = { SELF: 0, DEPARTMENT: 1, BRANCH: 2, COMPANY: 3 };

/** Phạm vi rộng nhất trong danh sách — dùng để quyết định lọc dữ liệu thế nào. */
export function widestScope(scopes: Array<{ level: string; value: string | null }>): {
  level: string;
  value: string | null;
} {
  let best = { level: 'SELF', value: null as string | null };
  for (const s of scopes) {
    if ((SCOPE_RANK[s.level] ?? -1) > (SCOPE_RANK[best.level] ?? -1)) best = s;
  }
  return best;
}

/**
 * Người dùng có được xem hàng dữ liệu này không?
 *
 * Đây là chỗ mà RBAC nhiều tầng thực sự có ý nghĩa: cùng một quyền
 * `payroll:read`, nhưng trưởng phòng chỉ thấy phòng mình.
 *
 * So khớp theo BỘ PHẬN / CHI NHÁNH của hàng. Không khớp thì false — mặc định
 * là TỪ CHỐI, không phải mặc định cho qua.
 */
export function canAccessRow(
  scopes: Array<{ level: string; value: string | null }>,
  row: { department?: string | null; branch?: string | null; ownerId?: string | null },
  userId: string,
): boolean {
  for (const s of scopes) {
    switch (s.level) {
      case 'COMPANY':
        return true;
      case 'BRANCH':
        if (s.value !== null && row.branch === s.value) return true;
        break;
      case 'DEPARTMENT':
        if (s.value !== null && row.department === s.value) return true;
        break;
      case 'SELF':
        if (row.ownerId !== null && row.ownerId === userId) return true;
        break;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// TẠO NGƯỜI DÙNG
// ---------------------------------------------------------------------------

export async function createUser(
  input: {
    username: string;
    password: string;
    fullName: string;
    email?: string;
    department?: string;
    branch?: string;
    roleCodes?: string[];
    scopeLevel?: 'COMPANY' | 'BRANCH' | 'DEPARTMENT' | 'SELF';
    scopeValue?: string | null;
    mustChangePassword?: boolean;
  },
  db: Db = getDb(),
): Promise<{ id: string }> {
  const [existing] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);
  if (existing) {
    throw new AuthError('USERNAME_TAKEN', `Tên đăng nhập '${input.username}' đã được dùng.`);
  }

  const [row] = await db
    .insert(users)
    .values({
      username: input.username,
      passwordHash: await hashPassword(input.password),
      fullName: input.fullName,
      email: input.email ?? null,
      department: input.department ?? null,
      branch: input.branch ?? null,
      mustChangePassword: input.mustChangePassword ?? true,
    })
    .returning({ id: users.id });

  for (const code of input.roleCodes ?? []) {
    const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.code, code)).limit(1);
    if (!role) {
      throw new AuthError('ROLE_NOT_FOUND', `Vai trò '${code}' chưa tồn tại.`);
    }
    await db.insert(userRoles).values({
      userId: row!.id,
      roleId: role.id,
      scopeLevel: input.scopeLevel ?? 'SELF',
      scopeValue: input.scopeValue ?? null,
    });
  }

  return { id: row!.id };
}

/**
 * Đổi mật khẩu.
 *
 * Đây là lối ra DUY NHẤT cho cờ `mustChangePassword`. Không có nó thì tài khoản
 * do admin tạo (mặc định bật cờ này) bị chặn khỏi mọi route vĩnh viễn — gate mà
 * không có cửa mở thì không phải bảo mật, chỉ là tự khoá mình.
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  db: Db = getDb(),
): Promise<{ revokedSessions: number }> {
  const found = await db
    .select({ id: users.id, passwordHash: users.passwordHash })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const user = found[0];
  if (!user) throw new AuthError('USER_NOT_FOUND', 'Không tìm thấy người dùng');

  // Xác minh mật khẩu hiện tại — không cho phép đổi chỉ dựa vào access token còn
  // hiệu lực. Máy để quên màn hình đang đăng nhập không được thành máy đổi mật khẩu.
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw new AuthError('WRONG_PASSWORD', 'Mật khẩu hiện tại không đúng');
  }

  const problems = checkPasswordStrength(newPassword);
  if (problems.length > 0) {
    throw new AuthError('WEAK_PASSWORD', problems.join('; '));
  }

  // Chặn đặt lại đúng mật khẩu cũ. Cờ mustChangePassword mà cho phép "đổi" thành
  // chính nó thì lá cờ đó không có tác dụng gì.
  if (await verifyPassword(newPassword, user.passwordHash)) {
    throw new AuthError('SAME_PASSWORD', 'Mật khẩu mới phải khác mật khẩu hiện tại');
  }

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(newPassword),
      mustChangePassword: false,
      updatedAt: new Date(),
    })
    .where(eq(users.id, userId));

  // Thu hồi MỌI phiên, kể cả phiên hiện tại. Nếu mật khẩu cũ đã lộ thì kẻ giữ
  // nó đang có một refresh token hợp lệ — đổi mật khẩu mà không thu hồi thì việc
  // đổi đó vô nghĩa. Client sẽ phải đăng nhập lại; đó là hành vi đúng.
  const revoked = await revokeAllSessions(userId, db);
  return { revokedSessions: revoked };
}

/** Thu hồi mọi phiên của một người dùng — dùng khi đổi mật khẩu hoặc nghi ngờ lộ. */
export async function revokeAllSessions(userId: string, db: Db = getDb()): Promise<number> {
  const revoked = await db
    .update(refreshTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(refreshTokens.userId, userId), sql`${refreshTokens.revokedAt} IS NULL`))
    .returning({ id: refreshTokens.id });
  return revoked.length;
}

/**
 * Dọn refresh token đã hết hạn quá 30 ngày.
 *
 * Chỉ xoá token HẾT HẠN. Bản đầu tiên của hàm này viết
 * `or(lt(expiresAt, cutoff), gt(expiresAt, cutoff))` — luôn đúng — và sẽ xoá
 * SẠCH mọi token còn hiệu lực, đăng xuất toàn bộ người dùng mỗi lần chạy dọn
 * dẹp. Một điều kiện đúng với mọi hàng trông vẫn "hợp lệ" về mặt cú pháp và
 * không có lỗi nào hiện ra cho tới khi mọi người bị đá ra.
 */
export async function pruneExpiredTokens(db: Db = getDb()): Promise<number> {
  const cutoff = new Date(Date.now() - 30 * 86_400_000);
  const deleted = await db
    .delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, cutoff))
    .returning({ id: refreshTokens.id });
  return deleted.length;
}
