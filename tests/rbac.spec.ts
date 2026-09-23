/**
 * Test tầng RBAC cho route handler.
 *
 * Hai nhóm quan trọng nhất:
 *   1. Phân tách 401 và 403 — gộp hai cái làm một thì client không biết nên
 *      "đăng nhập lại" hay "đừng thử nữa".
 *   2. `authErrorResponse` KHÔNG được nuốt lỗi lạ thành 401. Đó là cách nhanh
 *      nhất để biến một bug thật (DB chết, thiếu secret) thành "hết phiên",
 *      và người dùng cứ đăng nhập lại mãi mà không ai biết hệ thống đang hỏng.
 */

import { describe, it, expect } from 'vitest';
import { AccessError, authErrorResponse, bearerToken } from '../src/lib/rbac';
import { safeRedirectTarget } from '../src/lib/safe-redirect';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/test', { headers });
}

describe('bearerToken', () => {
  it('đọc được token hợp lệ', () => {
    expect(bearerToken(req({ authorization: 'Bearer abc.def.ghi' }))).toBe('abc.def.ghi');
  });

  it('không phân biệt hoa thường ở chữ Bearer', () => {
    // RFC 7235: scheme không phân biệt hoa thường. Bắt buộc "Bearer" đúng chữ
    // hoa sẽ làm hỏng mọi client viết "bearer".
    expect(bearerToken(req({ authorization: 'bearer abc' }))).toBe('abc');
    expect(bearerToken(req({ authorization: 'BEARER abc' }))).toBe('abc');
  });

  it('bỏ khoảng trắng thừa', () => {
    expect(bearerToken(req({ authorization: '   Bearer   abc   ' }))).toBe('abc');
  });

  it('header vắng → null', () => {
    expect(bearerToken(req())).toBeNull();
    expect(bearerToken(req({ 'content-type': 'application/json' }))).toBeNull();
  });

  it('scheme khác → null', () => {
    expect(bearerToken(req({ authorization: 'Basic dXNlcjpwdw==' }))).toBeNull();
    // Token trần không có scheme cũng phải từ chối: chấp nhận nó nghĩa là chấp
    // nhận mọi chuỗi ngẫu nhiên ở header này.
    expect(bearerToken(req({ authorization: 'abc.def.ghi' }))).toBeNull();
  });

  it('Bearer rỗng → null, không phải chuỗi rỗng', () => {
    // Chuỗi rỗng mà đi tiếp xuống verifyAccessToken thì thành "MALFORMED" thay
    // vì "thiếu token" — thông báo sai cho người dùng thật.
    expect(bearerToken(req({ authorization: 'Bearer ' }))).toBeNull();
    expect(bearerToken(req({ authorization: 'Bearer' }))).toBeNull();
    expect(bearerToken(req({ authorization: 'Bearer    ' }))).toBeNull();
  });

  it('không dính chữ Bearer ở giữa chuỗi', () => {
    expect(bearerToken(req({ authorization: 'xBearer abc' }))).toBeNull();
  });
});

describe('AccessError — 401 và 403 phải khác nhau', () => {
  it('FORBIDDEN → 403: có danh tính nhưng không được phép', () => {
    const e = new AccessError('FORBIDDEN', 'Thiếu quyền gl:post');
    expect(e.status).toBe(403);
    expect(e.code).toBe('FORBIDDEN');
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe('AccessError');
  });

  it('UNAUTHORIZED → 401: chưa chứng minh được danh tính', () => {
    const e = new AccessError('UNAUTHORIZED', 'Thiếu access token');
    expect(e.status).toBe(401);
  });

  it('MUST_CHANGE_PASSWORD → 401, không phải 403', () => {
    // Đây là vấn đề của PHIÊN chứ không phải của quyền: đăng nhập lại và đổi
    // mật khẩu là hết. Trả 403 sẽ khiến client tưởng người dùng bị cắt quyền.
    expect(new AccessError('MUST_CHANGE_PASSWORD', 'x').status).toBe(401);
  });

  it('message đi kèm để log phía server', () => {
    expect(new AccessError('FORBIDDEN', 'Thiếu quyền gl:post').message).toBe('Thiếu quyền gl:post');
  });
});

describe('authErrorResponse', () => {
  it('AccessError → JSON đúng hình dạng, đúng status', async () => {
    const res = authErrorResponse(new AccessError('FORBIDDEN', 'Thiếu quyền gl:post'));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('Thiếu quyền gl:post');
  });

  it('kèm Cache-Control: no-store — quyết định từ chối không được cache', async () => {
    // Nếu một proxy cache câu trả lời 403 rồi sau đó người dùng được cấp quyền,
    // họ vẫn bị chặn cho tới khi cache hết hạn.
    const res = authErrorResponse(new AccessError('UNAUTHORIZED', 'x'));
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('lỗi KHÔNG phải AccessError thì NÉM LẠI, không nuốt thành 401', () => {
    // Đây là test quan trọng nhất của file. Bắt mọi lỗi rồi trả 401 nghe "an
    // toàn" nhưng thực ra che mất lỗi thật: DB chết, thiếu JWT_SECRET, hay một
    // TypeError trong handler — tất cả sẽ hiện ra thành "hết phiên", người dùng
    // cứ đăng nhập lại mãi, và không một dòng log nào cho biết hệ thống đang hỏng.
    const dbError = new Error('connection terminated unexpectedly');
    expect(() => authErrorResponse(dbError)).toThrow('connection terminated unexpectedly');
  });

  it('lỗi không phải Error cũng ném lại', () => {
    expect(() => authErrorResponse('chuỗi lỗi')).toThrow();
    expect(() => authErrorResponse(null)).toThrow();
  });
});

describe('safeRedirectTarget — chặn open redirect', () => {
  it('đường dẫn trong site thì giữ nguyên', () => {
    expect(safeRedirectTarget('/payroll')).toBe('/payroll');
    expect(safeRedirectTarget('/payroll/abc-123')).toBe('/payroll/abc-123');
    expect(safeRedirectTarget('/')).toBe('/');
  });

  it('rỗng hoặc thiếu → trang chủ', () => {
    expect(safeRedirectTarget(null)).toBe('/');
    expect(safeRedirectTarget(undefined)).toBe('/');
    expect(safeRedirectTarget('')).toBe('/');
  });

  it('URL tuyệt đối → trang chủ', () => {
    expect(safeRedirectTarget('https://evil.com')).toBe('/');
    expect(safeRedirectTarget('http://evil.com/x')).toBe('/');
    // javascript: là vector XSS chứ không chỉ redirect
    expect(safeRedirectTarget('javascript:alert(1)')).toBe('/');
    expect(safeRedirectTarget('data:text/html,<script>')).toBe('/');
  });

  it('protocol-relative → trang chủ (nguy hiểm nhất)', () => {
    // Cái này QUA ĐƯỢC kiểm tra startsWith('/') — trình duyệt hiểu `//evil.com`
    // là "tới evil.com bằng protocol hiện tại". Đây là lý do hàm này tồn tại.
    expect(safeRedirectTarget('//evil.com')).toBe('/');
    expect(safeRedirectTarget('//evil.com/payroll')).toBe('/');
  });

  it('backslash — một số trình duyệt đổi thành slash', () => {
    expect(safeRedirectTarget('/\\evil.com')).toBe('/');
    expect(safeRedirectTarget('/\\\\evil.com')).toBe('/');
  });

  it('ký tự điều khiển hoặc khoảng trắng → trang chủ', () => {
    expect(safeRedirectTarget('/\thttps://evil.com')).toBe('/');
    expect(safeRedirectTarget('/\n/x')).toBe('/');
    expect(safeRedirectTarget('/ /x')).toBe('/');
    expect(safeRedirectTarget('/\u0000/x')).toBe('/');
  });
});
