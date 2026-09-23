'use client';

/**
 * Giữ access token ở phía client.
 *
 * ĐÂY LÀ ĐÁNH ĐỔI CÓ Ý THỨC, không phải sơ suất:
 *
 * Access token nằm trong localStorage thì đọc được bởi bất kỳ script nào chạy
 * trên trang — nếu có lỗ hổng XSS thì token lộ. Cách "đúng sách" là để cả access
 * token trong cookie HttpOnly và dùng BFF, nhưng khi đó mọi request phải đi qua
 * một tầng proxy và mất khả năng gọi API trực tiếp.
 *
 * Điều làm cho đánh đổi này chấp nhận được: access token chỉ sống 15 phút, và
 * refresh token THÌ đã ở trong cookie HttpOnly với Path=/api/auth — nên thứ bị lộ
 * qua XSS là một vé 15 phút, không phải phiên 14 ngày. Đổi lại nếu cần: chuyển
 * access token sang cookie HttpOnly và thêm một endpoint /api/me.
 */

const KEY = 'amis.accessToken';

export function setAccessToken(token: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    /* private mode / storage bị chặn — phiên chỉ sống trong tab này */
  }
}

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function clearAccessToken(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* không có gì để làm */
  }
}

/**
 * Gọi API có bảo vệ.
 *
 * Tự gắn header và tự xử lý 401: token hết hạn thì xoá và đưa về trang đăng
 * nhập. Nếu không làm vậy thì người dùng thấy một lỗi khó hiểu và phải tự biết
 * mà F5 — trong khi hệ thống biết chính xác chuyện gì đang xảy ra.
 */
export async function api(
  path: string,
  init: RequestInit & { json?: unknown } = {},
): Promise<Response> {
  const { json, headers, ...rest } = init;
  const token = getAccessToken();
  const res = await fetch(path, {
    ...rest,
    headers: {
      ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });

  if (res.status === 401 && typeof window !== 'undefined') {
    clearAccessToken();
    const back = encodeURIComponent(window.location.pathname);
    window.location.href = `/login?next=${back}`;
  }
  return res;
}
