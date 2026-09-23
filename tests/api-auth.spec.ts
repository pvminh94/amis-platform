/**
 * ============================================================================
 * MỌI API ROUTE PHẢI KIỂM TRA QUYỀN — hoặc khai báo rõ là công khai
 * ============================================================================
 *
 * Vì sao file này tồn tại: sáu route đã không có bất kỳ kiểm tra quyền nào và
 * sống qua 18 phase. Kiểm chứng bằng curl không kèm gì:
 *
 *   GET  /api/policies                            → 200, 33.413 byte chính sách
 *   GET  /api/reports/LUONG_THEO_BO_PHAN?format=csv → 200, CSV lương đầy đủ
 *   POST /api/policies/VN_PIT/versions  {}        → 400 INVALID_PARAMS
 *   POST /api/policies/…/activate                 → 400 VERSION_NOT_FOUND
 *   POST /api/approvals/<uuid>          {}        → 400 UNKNOWN_ACTION
 *
 * Ba dòng 400 là bằng chứng đắt giá nhất: nếu quyền được kiểm tra trước thì phải
 * là 401. Mã 400 nghĩa là request đã đi XUYÊN QUA tầng xác thực vào tới Zod và
 * state machine — tức là người ẩn danh chỉ cần gửi payload đúng là SỬA ĐƯỢC BIỂU
 * THUẾ, KÍCH HOẠT NÓ, và DUYỆT LƯƠNG.
 *
 * Test cũ không bắt được vì test gọi thẳng service layer hoặc gọi API kèm token
 * hợp lệ — tức là chỉ đi qua con đường đã được canh.
 *
 * Thiết kế ở đây là WHITELIST NGƯỢC: mặc định là phải có requirePermission.
 * Route nào muốn mở thì phải nằm trong PUBLIC_ROUTES kèm LÝ DO. Người sau thêm
 * route mới mà quên kiểm tra quyền thì test đỏ ngay; còn muốn mở thì phải sửa
 * danh sách này một cách có ý thức, và lý do phải viết ra.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const API = new URL('../src/app/api/', import.meta.url).pathname;

/**
 * Route được phép không xác thực — KÈM LÝ DO. Thêm vào đây là một quyết định
 * bảo mật, không phải một chi tiết cài đặt.
 */
const PUBLIC_ROUTES: Record<string, string> = {
  // Không thể đòi token để lấy token.
  'auth/login': 'điểm vào — chưa có gì để xác thực',
  'auth/refresh': 'đổi refresh token lấy access token mới',
  'auth/logout': 'đăng xuất phải chạy được kể cả khi token đã hết hạn',
  // Probe sống còn cho orchestrator/uptime; không chứa dữ liệu nghiệp vụ.
  'health': 'health check cho load balancer, chỉ trả status + số migration',
  // Thiết bị chấm công không giữ được JWT — xác thực bằng khoá riêng của từng
  // máy, kiểm trong `authenticateDevice` chứ không phải `requirePermission`.
  'devices/adms': 'xác thực bằng webhook_key riêng (authenticateDevice)',
  'devices/hikvision': 'xác thực bằng webhook_key riêng (authenticateDevice)',
};

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) routeFiles(full, out);
    else if (name === 'route.ts') out.push(full);
  }
  return out;
}

const files = routeFiles(API).map((f) => ({
  key: relative(API, f).replace(/\/route\.ts$/, ''),
  file: f,
  src: readFileSync(f, 'utf8'),
}));

describe('mọi API route phải kiểm tra quyền hoặc khai báo là công khai', () => {
  it('có route để kiểm tra', () => {
    // Đường dẫn sai thì `files` rỗng và mọi test bên dưới "pass" vì không có gì
    // để kiểm tra — một test xanh giả.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('danh sách PUBLIC_ROUTES không chứa route không tồn tại', () => {
    // Route bị xoá/đổi tên mà quên dọn danh sách thì phải lộ ra, không thì danh
    // sách này thành chỗ ẩn nấp cho một route "công khai" không còn tồn tại.
    const keys = new Set(files.map((f) => f.key));
    const stale = Object.keys(PUBLIC_ROUTES).filter((k) => !keys.has(k));
    expect(stale).toEqual([]);
  });

  for (const { key, src } of files) {
    const reason = PUBLIC_ROUTES[key];

    if (reason) {
      it(`${key} — công khai có chủ ý (${reason})`, () => {
        // Đã khai công khai thì KHÔNG được gọi requirePermission, vì gọi là mâu
        // thuẫn: hoặc danh sách sai, hoặc code sai.
        expect(src).not.toContain('requirePermission(');
        expect(src).not.toMatch(/\bawait authenticate\(/);
      });
    } else {
      it(`${key} xác thực trước khi làm gì`, () => {
        // Hai cách hợp lệ:
        //   requirePermission(req, 'x:y') — cần danh tính VÀ một quyền cụ thể
        //   authenticate(req, …)          — chỉ cần danh tính. Dùng cho việc của
        //     chính người dùng, ví dụ đổi mật khẩu của mình: đòi một quyền ở đó
        //     là vô nghĩa, và nếu đòi thì người bị buộc đổi mật khẩu không bao giờ
        //     đổi được — một cái cổng tự khoá.
        const hasPermission = src.includes('requirePermission(');
        const hasIdentity = /\bawait authenticate\(/.test(src);
        expect(hasPermission || hasIdentity, `${key}: không có requirePermission lẫn authenticate`).toBe(true);
        // Có kiểm tra mà quên trả lỗi thì cũng như không: cả hai hàm trên đều ném
        // AccessError, phải bắt và chuyển thành authErrorResponse.
        expect(src).toContain('authErrorResponse(');
      });

      it(`${key} — MỌI handler đều được canh`, () => {
        // Đây là chỗ dễ lọt nhất: canh GET mà quên POST trên cùng một file.
        const handlers = [...src.matchAll(/^export async function (GET|POST|PATCH|PUT|DELETE)\(/gm)]
          .map((m) => m[1]);
        expect(handlers.length).toBeGreaterThan(0);
        const guards =
          (src.match(/await requirePermission\(/g) ?? []).length +
          (src.match(/await authenticate\(/g) ?? []).length;
        expect(
          guards,
          `${key}: ${handlers.length} handler (${handlers.join(',')}) nhưng chỉ ${guards} chỗ kiểm tra`,
        ).toBeGreaterThanOrEqual(handlers.length);
      });
    }
  }
});
