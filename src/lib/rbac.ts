/**
 * ============================================================================
 * RBAC cho route handler
 * ============================================================================
 *
 * Hai câu hỏi, trả lời riêng:
 *
 *   "Anh là ai?"        → access token (JWT, 15 phút). Rẻ, không chạm DB.
 *   "Anh được làm gì?"  → tra database. Đắt hơn, nhưng BẮT BUỘC.
 *
 * Vì sao quyền không nằm trong token: quyền có thể bị thu hồi. Nếu token tự
 * tuyên bố "tôi có payroll:write" thì một người vừa bị cắt quyền vẫn giữ nó cho
 * tới khi token hết hạn — tối đa 15 phút. Với thao tác ghi sổ kế toán hay duyệt
 * lương thì 15 phút đó là quá dài. Nên token chỉ chứng minh DANH TÍNH, còn quyền
 * luôn đọc lại từ DB tại thời điểm yêu cầu.
 *
 * Mặc định là TỪ CHỐI. Không có header, token hỏng, token hết hạn, hay thiếu
 * quyền — tất cả đều đi ra bằng lỗi, không có nhánh nào "coi như được".
 */

import { verifyAccessToken, type AccessTokenClaims } from '@/engine/auth';
import { getDb, type Db } from '@/db/client';
import { loadAuthority, type UserAuthority } from '@/lib/auth';

export class AccessError extends Error {
  code: 'UNAUTHORIZED' | 'FORBIDDEN' | 'MUST_CHANGE_PASSWORD';
  status: number;
  constructor(code: AccessError['code'], message: string) {
    super(message);
    this.name = 'AccessError';
    this.code = code;
    // Thiếu/không nhận diện được danh tính → 401 ("hãy đăng nhập").
    // Có danh tính nhưng không được phép → 403 ("đăng nhập lại cũng vô ích").
    // Gộp hai cái thành một mã sẽ khiến client không biết nên làm gì tiếp.
    this.status = code === 'FORBIDDEN' ? 403 : 401;
  }
}

export interface Principal {
  claims: AccessTokenClaims;
  authority: UserAuthority;
}

/** Đọc `Authorization: Bearer <token>`. Trả null nếu header vắng hoặc sai dạng. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1]?.trim() || null;
}

/**
 * Xác minh danh tính và nạp quyền. Ném `AccessError` nếu không qua.
 *
 * Thông báo lỗi cố tình MƠ HỒ với client: "token hết hạn" và "chữ ký sai" là
 * hai thông tin rất khác nhau với kẻ tấn công đang dò, nhưng vô dụng với người
 * dùng thật. `reason` được ghi vào `AccessError.message` để log phía server.
 */
export async function authenticate(
  req: Request,
  db: Db = getDb(),
  /**
   * Cho phép phiên đang bị ép đổi mật khẩu đi qua.
   *
   * Chỉ route đổi mật khẩu được bật cờ này — và bắt buộc phải có, vì nếu không
   * thì cờ `mustChangePassword` chặn luôn cả lối thoát duy nhất của nó.
   */
  opts: { allowMustChangePassword?: boolean } = {},
): Promise<Principal> {
  const token = bearerToken(req);
  if (!token) throw new AccessError('UNAUTHORIZED', 'Thiếu access token');

  const v = await verifyAccessToken(token);
  if (!v.ok || !v.claims) {
    throw new AccessError('UNAUTHORIZED', v.reason ?? 'Token không hợp lệ');
  }

  // Quyền đọc từ DB tại thời điểm này — xem ghi chú đầu file.
  const authority = await loadAuthority(v.claims.sub, db);

  // Phiên đang bị ép đổi mật khẩu thì không được làm gì ngoài việc đổi mật khẩu.
  // Chặn ở đây thay vì ở từng route, vì quên một route là thủng một lỗ.
  if (v.claims.mustChangePassword && !opts.allowMustChangePassword) {
    throw new AccessError('MUST_CHANGE_PASSWORD', 'Phiên này phải đổi mật khẩu trước');
  }

  return { claims: v.claims, authority };
}

/**
 * Như `authenticate`, cộng thêm kiểm tra một quyền cụ thể.
 *
 * Ném `FORBIDDEN` (403) khi thiếu quyền — khác với `UNAUTHORIZED` (401) để
 * client phân biệt được "đăng nhập đi" với "bạn không có quyền này".
 */
export async function requirePermission(
  req: Request,
  permission: string,
  db: Db = getDb(),
): Promise<Principal> {
  // KHÔNG nhận cờ allowMustChangePassword: một phiên chưa đổi mật khẩu thì không
  // được làm bất cứ việc gì khác ngoài việc đổi mật khẩu.
  const p = await authenticate(req, db);
  if (!p.authority.permissions.has(permission)) {
    throw new AccessError('FORBIDDEN', `Thiếu quyền ${permission}`);
  }
  return p;
}

/**
 * Biến `AccessError` thành response JSON.
 *
 * Đặt ở đây để mọi route trả cùng một hình dạng lỗi — client chỉ cần một chỗ
 * xử lý, và không route nào tự nghĩ ra mã riêng.
 */
export function authErrorResponse(e: unknown): Response {
  if (e instanceof AccessError) {
    return new Response(
      JSON.stringify({ error: { code: e.code, message: e.message } }),
      {
        status: e.status,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      },
    );
  }
  // KHÔNG phải lỗi xác thực thì không đoán — để nó nổi lên thành 500 thật sự.
  // Nuốt mọi lỗi thành 401 là cách nhanh nhất để che mất một bug.
  throw e;
}
