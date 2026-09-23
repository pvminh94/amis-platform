/**
 * ============================================================================
 * CSP phải khớp với những gì Next.js thật sự bơm vào trang
 * ============================================================================
 *
 * BUG THẬT ĐÃ XẢY RA: CSP đặt cứng `script-src 'self'` cho mọi môi trường.
 * `next dev` bơm 11 thẻ <script> inline và mở WebSocket tới HMR — cả hai bị chặn,
 * nên React không hydrate và NÚT ĐĂNG NHẬP BẤM KHÔNG NHẠY.
 *
 * Vì sao không test nào bắt được: trang vẫn render HTML đẹp ở phía server, và
 * `curl` không chạy JavaScript. Mọi lần kiểm tra bằng curl đều XANH trong khi
 * người dùng thật thì không bấm được gì.
 *
 * Bài học: một chính sách bảo mật chỉ đúng khi nó khớp với những gì ứng dụng
 * THẬT SỰ gửi đi. Kiểm tra HTTP phải đi kèm kiểm tra "header này có chặn thứ
 * gì mà trang đang cần không".
 */

import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { buildCsp } from '../src/lib/csp.js';

const { middleware } = await import('../src/middleware.js');

// Gọi thẳng `buildCsp(isDev)` thay vì đổi `process.env.NODE_ENV`: bundler thay
// thế tĩnh `process.env.NODE_ENV` thành hằng số lúc biên dịch, nên gán nó trong
// test KHÔNG có tác dụng — cả hai nhánh sẽ trả về cùng một CSP. Đó chính xác là
// lý do `isDev` được làm thành tham số.

/** Lấy nội dung của một directive, ví dụ directive(csp, 'script-src'). */
const directive = (csp: string, name: string): string => {
  const part = csp
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + ' '));
  return part ?? '';
};

describe('CSP theo môi trường', () => {
  const dev = buildCsp(true);
  const prod = buildCsp(false);

  it('có CSP ở cả hai môi trường', () => {
    expect(dev.length).toBeGreaterThan(0);
    expect(prod.length).toBeGreaterThan(0);
  });

  it('DEV cho phép inline script — nếu không React không hydrate được', () => {
    // Đây chính là dòng mà bản cũ thiếu, khiến nút đăng nhập bấm không nhảy.
    expect(directive(dev, 'script-src')).toContain("'unsafe-inline'");
  });

  it('DEV cho phép eval — webpack dev middleware cần nó', () => {
    expect(directive(dev, 'script-src')).toContain("'unsafe-eval'");
  });

  it('DEV cho phép ws: — kênh HMR, thiếu thì không hot reload', () => {
    expect(directive(dev, 'connect-src')).toMatch(/\bws:/);
  });

  it('PRODUCTION phải CHẶT — không được nới theo dev', () => {
    // Nới dev là cần thiết, nhưng nới luôn production là mở lỗ hổng XSS.
    expect(directive(prod, 'script-src')).not.toContain("'unsafe-inline'");
    expect(prod).not.toContain("'unsafe-eval'");
    expect(directive(prod, 'connect-src')).not.toMatch(/\bws:/);
  });

  // Ba cái này KHÔNG được nới ở bất kỳ môi trường nào.
  for (const [label, csp] of [
    ['dev', dev],
    ['production', prod],
  ] as const) {
    it(`${label}: vẫn giữ frame-ancestors 'none' (chống clickjacking)`, () => {
      expect(csp).toContain("frame-ancestors 'none'");
    });
    it(`${label}: vẫn giữ base-uri 'self' (chống chèn <base>)`, () => {
      expect(csp).toContain("base-uri 'self'");
    });
    it(`${label}: vẫn giữ form-action 'self'`, () => {
      expect(csp).toContain("form-action 'self'");
    });
  }
});

describe('security headers khác không bị mất khi sửa CSP', () => {
  const res = middleware(new NextRequest('http://localhost:3100/login'));
  for (const h of [
    'x-frame-options',
    'x-content-type-options',
    'referrer-policy',
    'cross-origin-opener-policy',
  ]) {
    it(`vẫn gửi ${h}`, () => {
      expect(res.headers.get(h)).not.toBeNull();
    });
  }
  it('X-Frame-Options là DENY', () => {
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});
