/**
 * ============================================================================
 * BẢO VỆ CÁC TRANG RSC
 * ============================================================================
 *
 * Mọi trang render phía server phải gọi `await requirePageSession()` ở dòng đầu.
 *
 * Vì sao tầng API có `requirePermission` mà trang vẫn hở: API đòi header
 * `Authorization`, còn trang RSC chạy trên server và chỉ nhìn thấy COOKIE. Hai
 * đường vào dữ liệu khác nhau, và chỉ một đường được canh. Kết quả trước khi có
 * file này: `curl /payroll` không cần đăng nhập vẫn trả về tổng lương thật.
 *
 * Kiểm tra ở ĐÂY (Node runtime, có DB) chứ không chỉ ở middleware (Edge, không có
 * DB): middleware chỉ chặn được "không có cookie", còn cookie hết hạn hay chữ ký
 * sai thì phải verify JWT mới biết. Middleware là cổng rẻ tiền để đỡ một vòng
 * render, đây mới là kiểm tra có thẩm quyền.
 */

import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { verifyAccessToken } from '@/engine/auth';
import { SESSION_COOKIE } from '@/lib/cookies';

export interface PageSession {
  sub: string;
  username: string;
  roles: string[];
  mustChangePassword: boolean;
}

/**
 * Trả phiên hợp lệ, hoặc redirect sang /login.
 *
 * KHÔNG ném lỗi và KHÔNG trả null: một trang quên xử lý null sẽ render tiếp với
 * dữ liệu rỗng và trông như "không có dữ liệu", tức là che mất việc người dùng
 * chưa đăng nhập. `redirect()` của Next ném một lỗi đặc biệt để dừng render —
 * đó là hành vi ta muốn.
 */
export async function requirePageSession(): Promise<PageSession> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  // Trang /login cần biết "đã đăng nhập chưa" để đưa về trang chủ, nhưng không
  // được redirect — nên có hàm riêng không ném ở dưới.
  const target = `/login?next=${encodeURIComponent(await currentPath())}`;
  if (!token) redirect(target);

  const v = await verifyAccessToken(token);
  // `redirect()` trả `never` nhưng TypeScript không tự narrow union sau một lời
  // gọi hàm, nên phải kiểm tra lại `v.ok` trong nhánh trả về. Viết
  // `if (!v.ok) redirect(...); return v.claims;` là lỗi biên dịch.
  if (!v.ok || !v.claims) redirect(target);
  return v.claims;
}

/**
 * Đọc phiên nếu có, không redirect. Dùng cho /login và các chỗ cần phân nhánh.
 */
export async function readPageSession(): Promise<PageSession | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const v = await verifyAccessToken(token);
  return v.ok && v.claims ? v.claims : null;
}

/**
 * Đường dẫn hiện tại để sau khi đăng nhập thì quay lại đúng chỗ.
 *
 * `next` được `/login` xử lý qua `safeRedirect` — chỉ cho phép đường dẫn tương
 * đối, nên không thành lỗ open redirect.
 */
async function currentPath(): Promise<string> {
  // Trong RSC không có `window`, và Next KHÔNG đưa đường dẫn vào `headers()`.
  // Nên middleware set `x-pathname` khi chuyển tiếp request — đó là lý do dòng đó
  // tồn tại trong middleware.ts. Nếu thiếu header (gọi ngoài HTTP) thì về '/'.
  const h = await headers();
  const p = h.get('x-pathname');
  if (!p || !p.startsWith('/') || p.startsWith('//')) return '/';
  return p;
}
