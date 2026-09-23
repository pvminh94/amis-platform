/**
 * ============================================================================
 * ENGINE XÁC THỰC — băm mật khẩu, ký JWT, băm refresh token
 * ============================================================================
 *
 * THUẦN LOGIC + CRYPTO, không chạm database. Mọi thứ cần DB nằm ở lib/auth.ts.
 * Nhờ vậy test được toàn bộ mà không cần PostgreSQL.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

// ---------------------------------------------------------------------------
// MẬT KHẨU
// ---------------------------------------------------------------------------

/**
 * Salt 10 — theo yêu cầu đặc tả.
 *
 * Đây là đánh đổi có ý thức: ~100ms mỗi lần băm, đủ chậm để brute-force offline
 * đắt, đủ nhanh để đăng nhập không khó chịu. Tăng lên 12 nhân bốn thời gian và
 * làm nghẽn luồng đăng nhập khi có burst. Nếu cần mạnh hơn thì đổi THUẬT TOÁN
 * (argon2id), không phải tăng salt.
 */
export const BCRYPT_SALT_ROUNDS = 10;

export const PASSWORD_MIN_LENGTH = 10;

/**
 * Kiểm tra độ mạnh mật khẩu.
 *
 * Không đòi ký tự đặc biệt — nghiên cứu (và NIST SP 800-63B) đều chỉ ra rằng
 * ép ký tự đặc biệt làm người dùng chọn mẫu dễ đoán như "Password1!". Độ DÀI
 * mới là thứ tạo entropy.
 */
export function checkPasswordStrength(pw: string): string[] {
  const problems: string[] = [];
  if (pw.length < PASSWORD_MIN_LENGTH) {
    problems.push(`Mật khẩu phải dài ít nhất ${PASSWORD_MIN_LENGTH} ký tự.`);
  }
  if (/^[a-z]+$/i.test(pw)) problems.push('Mật khẩu chỉ có chữ thì dễ dò hơn nhiều.');
  if (/^\d+$/.test(pw)) problems.push('Mật khẩu chỉ có số thì dễ dò hơn nhiều.');
  const COMMON = ['password', 'matkhau', '123456', 'qwerty', 'admin', 'amis'];
  const lower = pw.toLowerCase();
  for (const c of COMMON) {
    if (lower.includes(c)) {
      problems.push(`Mật khẩu chứa '${c}' — nằm trong danh sách dò đầu tiên của mọi công cụ.`);
    }
  }
  return problems;
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  // bcrypt.compare tự so sánh an toàn theo thời gian. Nhưng nếu hash RỖNG hoặc
  // sai định dạng thì nó ném — phải bắt lại để trả về false thay vì 500.
  if (!hash.startsWith('$2')) return false;
  try {
    return await bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// JWT
// ---------------------------------------------------------------------------

export interface AccessTokenClaims {
  sub: string;
  username: string;
  roles: string[];
  /** Có phải phiên đang bị ép đổi mật khẩu không. */
  mustChangePassword: boolean;
}

export interface VerifyResult {
  ok: boolean;
  claims?: AccessTokenClaims;
  /** Lý do thất bại — để log và để trả thông báo đúng, không phải để lộ cho client. */
  reason?: 'EXPIRED' | 'BAD_SIGNATURE' | 'MALFORMED' | 'NO_SECRET';
}

const ALG = 'HS256';
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 phút

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Đọc secret từ môi trường.
 *
 * NÉM LỖI nếu thiếu hoặc yếu — KHÔNG sinh secret ngẫu nhiên rồi chạy tiếp.
 * Một secret sinh lúc chạy nghĩa là mọi token mất hiệu lực mỗi lần restart
 * (tệ), và tệ hơn: trên nhiều tiến trình thì mỗi tiến trình một secret nên
 * token của tiến trình này vô nghĩa với tiến trình kia.
 */
export function requireJwtSecret(): string {
  const s = process.env.JWT_SECRET;
  if (!s) {
    throw new Error(
      'JWT_SECRET chưa được đặt. Không tự sinh secret ngẫu nhiên vì mọi token ' +
        'sẽ mất hiệu lực khi restart và mỗi tiến trình sẽ có một secret khác nhau.',
    );
  }
  if (s.length < 32) {
    throw new Error(
      `JWT_SECRET phải dài ít nhất 32 ký tự cho HS256 (hiện ${s.length}). ` +
        `Secret ngắn thì brute-force khoá rẻ hơn nhiều so với brute-force mật khẩu.`,
    );
  }
  return s;
}

export async function signAccessToken(
  claims: AccessTokenClaims,
  opts: { ttlSeconds?: number; secret?: string } = {},
): Promise<string> {
  const secret = opts.secret ?? requireJwtSecret();
  const ttl = opts.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  return new SignJWT({
    username: claims.username,
    roles: claims.roles,
    mcp: claims.mustChangePassword,
  })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setIssuer('amis-platform')
    .setAudience('amis-platform')
    .setExpirationTime(`${ttl}s`)
    .setJti(randomBytes(12).toString('hex'))
    .sign(secretKey(secret));
}

export async function verifyAccessToken(
  token: string,
  secret = process.env.JWT_SECRET ?? '',
): Promise<VerifyResult> {
  if (!secret) return { ok: false, reason: 'NO_SECRET' };
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), {
      // Chốt thuật toán. Không chốt thì kẻ tấn công đổi header sang alg=none
      // hoặc trỏ sang khoá công khai — lỗi kinh điển nhất của JWT.
      algorithms: [ALG],
      issuer: 'amis-platform',
      audience: 'amis-platform',
    });
    return {
      ok: true,
      claims: {
        sub: String(payload.sub ?? ''),
        username: String(payload.username ?? ''),
        roles: Array.isArray(payload.roles) ? (payload.roles as string[]) : [],
        mustChangePassword: payload.mcp === true,
      },
    };
  } catch (e) {
    if (e instanceof joseErrors.JWTExpired) return { ok: false, reason: 'EXPIRED' };
    if (e instanceof joseErrors.JWSSignatureVerificationFailed) {
      return { ok: false, reason: 'BAD_SIGNATURE' };
    }
    return { ok: false, reason: 'MALFORMED' };
  }
}

// ---------------------------------------------------------------------------
// REFRESH TOKEN
// ---------------------------------------------------------------------------

export const REFRESH_TOKEN_TTL_DAYS = 14;

/** Token mờ (opaque) — không phải JWT, vì nó chỉ cần tra cứu được trong DB. */
export function generateRefreshToken(): string {
  // 32 byte = 256 bit entropy. base64url để nằm gọn trong cookie.
  return randomBytes(32).toString('base64url');
}

/**
 * Băm refresh token để lưu.
 *
 * SHA-256 chứ không phải bcrypt: token đã có 256 bit entropy nên không cần làm
 * chậm, và ta cần tra cứu bằng equality (bcrypt không so sánh được nếu không
 * có bản gốc). Lý do băm mật khẩu là mật khẩu entropy THẤP — token thì không.
 */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

// ---------------------------------------------------------------------------
// SO SÁNH AN TOÀN THEO THỜI GIAN
// ---------------------------------------------------------------------------

/**
 * So sánh chuỗi không rò rỉ thời gian.
 *
 * `a === b` dừng ở ký tự khác đầu tiên, nên đo thời gian phản hồi sẽ suy ra
 * được từng ký tự. Với mã token hay chữ ký thì đó là một cách tấn công thật.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual ném nếu độ dài khác nhau — phải kiểm tra trước, nhưng
  // việc kiểm tra độ dài chỉ rò rỉ độ dài, không rò rỉ nội dung.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
