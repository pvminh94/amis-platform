/**
 * Test engine xác thực.
 *
 * Nhóm quan trọng nhất là các đường tấn công JWT: đổi thuật toán, sai khoá,
 * hết hạn, sai issuer/audience. Nếu những test này xanh thì token giả không
 * vào được; nếu thiếu chúng thì "JWT hoạt động" chỉ có nghĩa là đường vui
 * hoạt động.
 */

import { describe, it, expect } from 'vitest';
import {
  BCRYPT_SALT_ROUNDS,
  hashPassword,
  verifyPassword,
  checkPasswordStrength,
  signAccessToken,
  verifyAccessToken,
  requireJwtSecret,
  generateRefreshToken,
  hashRefreshToken,
  safeEqual,
  ACCESS_TOKEN_TTL_SECONDS,
  type AccessTokenClaims,
} from '../src/engine/auth';

const SECRET = 'test-secret-that-is-long-enough-for-hs256-ok';
const CLAIMS: AccessTokenClaims = {
  sub: 'user-1',
  username: 'hr.admin',
  roles: ['HR_ADMIN'],
  mustChangePassword: false,
};

describe('mật khẩu — bcrypt', () => {
  it('salt đúng 10 round theo đặc tả', () => {
    expect(BCRYPT_SALT_ROUNDS).toBe(10);
  });

  it('hash có tiền tố $2 và nhúng số round', async () => {
    const h = await hashPassword('MatKhauManh2026');
    expect(h.startsWith('$2')).toBe(true);
    // bcrypt nhúng cost vào hash: $2a$10$… hoặc $2b$10$…
    expect(h.split('$')[2]).toBe('10');
  });

  it('hai lần băm cùng một mật khẩu cho hai hash KHÁC NHAU (salt ngẫu nhiên)', async () => {
    const a = await hashPassword('MatKhauManh2026');
    const b = await hashPassword('MatKhauManh2026');
    expect(a).not.toBe(b);
    // Nhưng cả hai đều verify được — đó là điểm của salt.
    expect(await verifyPassword('MatKhauManh2026', a)).toBe(true);
    expect(await verifyPassword('MatKhauManh2026', b)).toBe(true);
  });

  it('sai mật khẩu thì false', async () => {
    const h = await hashPassword('MatKhauManh2026');
    expect(await verifyPassword('MatKhauManh2027', h)).toBe(false);
  });

  it('hash rác trả về false chứ không ném 500', async () => {
    expect(await verifyPassword('x', '')).toBe(false);
    expect(await verifyPassword('x', 'không phải hash')).toBe(false);
    expect(await verifyPassword('x', '$2a$10$ngandon')).toBe(false);
  });

  it('mật khẩu rỗng không verify được với hash hợp lệ', async () => {
    const h = await hashPassword('MatKhauManh2026');
    expect(await verifyPassword('', h)).toBe(false);
  });
});

describe('độ mạnh mật khẩu', () => {
  it('ngắn hơn 10 ký tự bị từ chối', () => {
    expect(checkPasswordStrength('Ab1!').length).toBeGreaterThan(0);
  });

  it('chỉ chữ, hoặc chỉ số, bị cảnh báo', () => {
    expect(checkPasswordStrength('abcdefghijk').join(' ')).toMatch(/chỉ có chữ/);
    expect(checkPasswordStrength('123456789012').join(' ')).toMatch(/chỉ có số/);
  });

  it('chứa từ phổ biến bị cảnh báo', () => {
    const p = checkPasswordStrength('MatKhau password 2026');
    expect(p.join(' ')).toMatch(/password/);
  });

  it('mật khẩu đủ dài và lẫn ký tự thì sạch', () => {
    expect(checkPasswordStrength('Xoay9vong!Tren2Nui')).toEqual([]);
  });
});

describe('JWT — đường vui', () => {
  it('ký rồi verify ra đúng claims', async () => {
    const token = await signAccessToken(CLAIMS, { secret: SECRET });
    const r = await verifyAccessToken(token, SECRET);
    expect(r.ok).toBe(true);
    expect(r.claims?.sub).toBe('user-1');
    expect(r.claims?.username).toBe('hr.admin');
    expect(r.claims?.roles).toEqual(['HR_ADMIN']);
  });

  it('mỗi lần ký ra token khác nhau (jti ngẫu nhiên)', async () => {
    const a = await signAccessToken(CLAIMS, { secret: SECRET });
    const b = await signAccessToken(CLAIMS, { secret: SECRET });
    expect(a).not.toBe(b);
  });

  it('cờ mustChangePassword đi qua được', async () => {
    const token = await signAccessToken({ ...CLAIMS, mustChangePassword: true }, { secret: SECRET });
    const r = await verifyAccessToken(token, SECRET);
    expect(r.claims?.mustChangePassword).toBe(true);
  });
});

describe('JWT — các đường tấn công', () => {
  it('token hết hạn bị từ chối với lý do EXPIRED', async () => {
    const token = await signAccessToken(CLAIMS, { secret: SECRET, ttlSeconds: -1 });
    const r = await verifyAccessToken(token, SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('EXPIRED');
  });

  it('token ký bằng khoá khác bị từ chối với BAD_SIGNATURE', async () => {
    const token = await signAccessToken(CLAIMS, { secret: SECRET });
    const r = await verifyAccessToken(token, 'another-secret-that-is-long-enough-xx');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BAD_SIGNATURE');
  });

  it('đổi một ký tự trong payload làm hỏng chữ ký', async () => {
    const token = await signAccessToken(CLAIMS, { secret: SECRET });
    const [h, p, s] = token.split('.');
    // Đổi 'hr.admin' thành 'adminxxx' trong payload, giữ nguyên chữ ký.
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    payload.username = 'adminxxx';
    payload.roles = ['SUPER_ADMIN'];
    const forged = [h, Buffer.from(JSON.stringify(payload)).toString('base64url'), s].join('.');
    const r = await verifyAccessToken(forged, SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('BAD_SIGNATURE');
  });

  it('alg=none bị từ chối — lỗi kinh điển nhất của JWT', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({ sub: 'user-1', username: 'admin', roles: ['SUPER_ADMIN'], mcp: false }),
    ).toString('base64url');
    const r = await verifyAccessToken(`${header}.${payload}.`, SECRET);
    expect(r.ok).toBe(false);
  });

  it('đổi alg sang HS512 bị từ chối vì đã chốt thuật toán', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'x', username: 'y', roles: [] })).toString(
      'base64url',
    );
    const r = await verifyAccessToken(`${header}.${payload}.abc`, SECRET);
    expect(r.ok).toBe(false);
  });

  it('sai issuer bị từ chối', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ username: 'x', roles: [], mcp: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('khac')
      .setAudience('amis-platform')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
    const r = await verifyAccessToken(token, SECRET);
    expect(r.ok).toBe(false);
  });

  it('sai audience bị từ chối', async () => {
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ username: 'x', roles: [], mcp: false })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-1')
      .setIssuer('amis-platform')
      .setAudience('ung-dung-khac')
      .setExpirationTime('15m')
      .sign(new TextEncoder().encode(SECRET));
    expect((await verifyAccessToken(token, SECRET)).ok).toBe(false);
  });

  it('token rác → MALFORMED, không ném', async () => {
    const r = await verifyAccessToken('rác.không.phải.jwt', SECRET);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('MALFORMED');
  });

  it('không có secret thì NO_SECRET chứ không phải "hợp lệ"', async () => {
    const token = await signAccessToken(CLAIMS, { secret: SECRET });
    const r = await verifyAccessToken(token, '');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NO_SECRET');
  });
});

describe('requireJwtSecret', () => {
  const original = process.env.JWT_SECRET;

  it('thiếu secret thì NÉM, không tự sinh', async () => {
    delete process.env.JWT_SECRET;
    // Tự sinh secret nghĩa là mọi token mất hiệu lực khi restart, và mỗi tiến
    // trình một secret nên token của tiến trình này vô nghĩa với tiến trình kia.
    expect(() => requireJwtSecret()).toThrow(/JWT_SECRET chưa được đặt/);
    process.env.JWT_SECRET = original;
  });

  it('secret ngắn hơn 32 ký tự thì ném', () => {
    process.env.JWT_SECRET = 'ngan';
    expect(() => requireJwtSecret()).toThrow(/ít nhất 32/);
    process.env.JWT_SECRET = original;
  });

  it('access token mặc định sống 15 phút — đủ ngắn để lộ token không quá tai hại', () => {
    expect(ACCESS_TOKEN_TTL_SECONDS).toBe(900);
  });
});

describe('refresh token', () => {
  it('mỗi lần sinh một token khác nhau', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
  });

  it('token đủ dài (base64url của 32 byte = 43 ký tự)', () => {
    expect(generateRefreshToken().length).toBeGreaterThanOrEqual(43);
  });

  it('hash ổn định và là hex 64 ký tự', () => {
    const t = generateRefreshToken();
    expect(hashRefreshToken(t)).toBe(hashRefreshToken(t));
    expect(hashRefreshToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hai token khác nhau cho hai hash khác nhau', () => {
    expect(hashRefreshToken(generateRefreshToken())).not.toBe(
      hashRefreshToken(generateRefreshToken()),
    );
  });
});

describe('safeEqual — so sánh không rò rỉ thời gian', () => {
  it('bằng nhau thì true', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
  });

  it('khác nhau thì false', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
  });

  it('khác độ dài thì false, không ném', () => {
    // timingSafeEqual ném nếu độ dài khác — phải kiểm tra trước.
    expect(safeEqual('abc', 'abcdef')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });
});
