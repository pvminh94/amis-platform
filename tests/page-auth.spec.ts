/**
 * ============================================================================
 * TEST CHỐNG TÁI PHẠM — mọi trang RSC phải được bảo vệ
 * ============================================================================
 *
 * Đây là test CẤU TRÚC, không phải test hành vi. Lý do nó tồn tại:
 *
 *   Lỗ hổng "mọi trang RSC đọc DB và render mà không kiểm tra phiên" đã tồn tại
 *   qua 17 phase mà không một test nào bắt được — vì mọi test đều gọi API, và
 *   API thì CÓ `requirePermission`. Hai đường vào dữ liệu, chỉ một đường được
 *   canh, và test chỉ đi qua đường được canh.
 *
 *   Kiểm tra hành vi (curl từng trang) thì làm được nhưng cần server chạy. Test
 *   này rẻ hơn và bắt được đúng cái lỗi dễ tái phạm nhất: người sau thêm một
 *   trang mới, copy từ trang cũ, và quên dòng `await requirePageSession()`.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const APP = new URL('../src/app/', import.meta.url).pathname;
const { sessionCookie, clearSessionCookie, SESSION_COOKIE } = await import('../src/lib/cookies.js');

/** Liệt kê mọi page.tsx dưới src/app. */
function pages(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) pages(full, out);
    else if (name === 'page.tsx') out.push(full);
  }
  return out;
}

const PUBLIC_PAGES = ['/login'];

describe('mọi trang RSC phải kiểm tra phiên', () => {
  const all = pages(APP).map((f) => ({ file: f, src: readFileSync(f, 'utf8') }));

  it('có trang để kiểm tra (test không âm thầm rỗng)', () => {
    // Nếu đường dẫn sai thì `pages()` trả [] và mọi assertion bên dưới "pass"
    // vì không có gì để kiểm tra — một test xanh giả.
    expect(all.length).toBeGreaterThanOrEqual(13);
  });

  for (const { file, src } of all) {
    const rel = '/' + relative(APP, file).replace(/\/page\.tsx$/, '').replace(/^page\.tsx$/, '');
    const isPublic = PUBLIC_PAGES.includes(rel);
    const isClient = src.startsWith("'use client'") || src.startsWith('"use client"');

    if (isPublic) {
      it(`${rel} là trang công khai — không được đòi phiên`, () => {
        // /login mà đòi phiên thì không ai đăng nhập được: vòng lặp vô hạn.
        expect(src).not.toContain('requirePageSession()');
      });
    } else if (isClient) {
      it(`${rel} là client component — middleware phải canh`, () => {
        // Client component không gọi được `cookies()`, nên nó chỉ được an toàn
        // nếu middleware chặn theo cookie và API mà nó gọi vẫn đòi quyền.
        const mw = readFileSync(new URL('../src/middleware.ts', import.meta.url).pathname, 'utf8');
        expect(mw).toContain("req.cookies.get('access_token')");
        // Và nó không được tự đọc DB (client component thì không thể, nhưng nếu
        // ai đó đổi thành server component mà quên bỏ 'use client' thì phải lộ ra).
        expect(src).not.toContain("from '@/db/client'");
      });
    } else {
      it(`${rel} gọi requirePageSession()`, () => {
        expect(src).toContain("from '@/lib/page-auth'");
        expect(src).toMatch(/await requirePageSession\(\)/);
      });
    }
  }
});

describe('middleware', () => {
  const mw = readFileSync(new URL('../src/middleware.ts', import.meta.url).pathname, 'utf8');

  it('chặn trang không có cookie phiên', () => {
    expect(mw).toContain("PUBLIC_PAGES");
    expect(mw).toContain("req.cookies.get('access_token')");
    expect(mw).toContain("pathname = '/login'");
  });

  it('KHÔNG chặn /api/ — API tự kiểm tra bằng requirePermission', () => {
    // Nếu middleware chặn cả /api/ theo cookie thì thiết bị chấm công (không có
    // cookie, xác thực bằng khoá riêng) sẽ bị đẩy về /login — một redirect HTML
    // cho một webhook expecting 200, và máy sẽ retry vô hạn.
    expect(mw).toContain("!pathname.startsWith('/api/')");
  });

  it('set x-pathname để trang biết quay lại đâu sau khi đăng nhập', () => {
    expect(mw).toContain("res.headers.set('x-pathname', pathname)");
  });
});

describe('cookie phiên', () => {
  it('access_token phải HttpOnly + Path=/ + SameSite=Lax', () => {
    const c = sessionCookie('tok', 900, true);
    // HttpOnly: JavaScript không đọc được nên XSS không lấy cắp được.
    expect(c).toContain('HttpOnly');
    // Path=/ : trang ở bất kỳ đường dẫn nào cũng phải nhận được cookie. Nếu để
    // Path=/api như refresh token thì trang RSC không bao giờ thấy nó — đó chính
    // là nguyên nhân gốc của lỗ hổng.
    expect(c).toContain('Path=/;');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Max-Age=900');
    expect(c.startsWith(`${SESSION_COOKIE}=tok`)).toBe(true);
  });

  it('không HTTPS thì bỏ cờ Secure (chạy local qua http)', () => {
    expect(sessionCookie('tok', 900, false)).not.toContain('Secure');
    expect(sessionCookie('tok', 900, true)).toContain('Secure');
  });

  it('cookie xoá phải Max-Age=0 và đúng Path', () => {
    const c = clearSessionCookie();
    expect(c).toContain('Max-Age=0');
    // Sai Path khi xoá là lỗi kinh điển: trình duyệt chỉ xoá cookie khớp path,
    // nên xoá với Path=/api/auth sẽ KHÔNG xoá được cookie có Path=/. Người dùng
    // "đăng xuất" xong F5 vẫn vào được trang.
    expect(c).toContain('Path=/;');
  });
});

// ---------------------------------------------------------------------------
// Cùng một bài học ở dạng khác: một endpoint có xác thực mà được mở bằng thẻ
// <a href> trần thì endpoint đó KHÔNG BAO GIỜ tải được, vì thẻ <a> không đính
// kèm được header Authorization. Lỗi này đã xảy ra thật ở bảng lịch sử /payments:
// nút "tải" trả về trang JSON 401.
// ---------------------------------------------------------------------------

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) tsxFiles(full, out);
    else if (name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('không mở endpoint có xác thực bằng thẻ <a href> trần', () => {
  const SRC = new URL('../src/', import.meta.url).pathname;
  const files = [...tsxFiles(join(SRC, 'app')), ...tsxFiles(join(SRC, 'components'))];

  it('có file để kiểm tra', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  // Chỉ khớp thẻ <a> THẬT. Regex ngây thơ `/href=\{?["'`]\/api\//` sẽ báo động
  // cả `<AuthDownload href="/api/…">` — chỗ mà `href` là một prop được chuyển vào
  // component có đính kèm token, tức là đúng. Một test bắt nhầm chỗ đúng thì lần
  // sau người ta sẽ xoá test đi.
  const BARE_ANCHOR = /<a[\s>][\s\S]{0,240}?href=\{?[`"']\/api\//;

  it('regex bắt đúng thẻ <a> trần và bỏ qua component', () => {
    // Tự kiểm tra công cụ trước khi dùng nó: nếu regex này sai thì assertion bên
    // dưới vô nghĩa dù xanh hay đỏ.
    expect(BARE_ANCHOR.test('<a\n  href={`/api/x/1/download`}\n>tải</a>')).toBe(true);
    expect(BARE_ANCHOR.test('<a href="/api/reports/X?format=csv">CSV</a>')).toBe(true);
    expect(BARE_ANCHOR.test('<AuthDownload\n  href={`/api/x/1/download`}\n  label="tải"\n/>')).toBe(false);
    expect(BARE_ANCHOR.test('<a href="/payroll">Bảng lương</a>')).toBe(false);
  });

  it('bộ lọc chú thích bỏ được cả chú thích JSX', () => {
    const strip = (x: string) => x.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const src = [
      '{/* <a href> nhận về 401 vì không đính kèm được Authorization */}',
      '<AuthDownload',
      '  href={`/api/payment-batches/1/download`}',
      '/>',
    ].join('\n');
    // Đây chính là trường hợp đã báo động nhầm: chữ "<a href>" nằm trong chú
    // thích, còn href="/api/…" là prop của component hợp lệ.
    expect(BARE_ANCHOR.test(src)).toBe(true);
    expect(BARE_ANCHOR.test(strip(src))).toBe(false);
  });

  it('không thẻ <a> nào trỏ thẳng vào /api/', () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // Bỏ chú thích — chính chú thích giải thích lỗi cũng chứa chuỗi này. Phải bỏ
      // CẢ chú thích khối: chú thích JSX viết là `{/* … */}`, không nằm ở đầu dòng
      // nên bộ lọc theo dòng bỏ sót, và regex (vốn cho phép nhảy dòng) sẽ bắt đầu từ
      // chữ "<a href>" TRONG CHÚ THÍCH rồi khớp vào thẻ <AuthDownload> bên dưới —
      // tức là báo động nhầm đúng chỗ đã sửa.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (BARE_ANCHOR.test(code)) bad.push(relative(SRC, f));
    }
    // Nếu danh sách này khác rỗng thì có một nút trên giao diện bấm vào là nhận
    // 401. Dùng `api()` + blob thay thế (xem batch-download.tsx).
    expect(bad).toEqual([]);
  });
});
