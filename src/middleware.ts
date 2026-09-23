/**
 * ============================================================================
 * MIDDLEWARE — security headers + CORS whitelist
 * ============================================================================
 *
 * Thay cho `helmet` (middleware của Express, không dùng được trong Next). Các
 * header ở đây làm đúng việc helmet làm, và quan trọng hơn: chúng áp dụng cho
 * MỌI phản hồi, kể cả những route quên nghĩ tới bảo mật.
 *
 * Chạy ở Edge runtime nên KHÔNG import module nào của Node.
 */

import { NextResponse, type NextRequest } from 'next/server';

/**
 * Danh sách origin được phép gọi API từ trình duyệt.
 *
 * Đọc từ biến môi trường, KHÔNG hardcode. '*' ở đây nghĩa là bất kỳ trang nào
 * cũng gọi được API của mình bằng cookie của người dùng — đúng định nghĩa CSRF.
 */
function allowedOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

const SECURITY_HEADERS: Record<string, string> = {
  // Không cho nhúng trang này trong iframe — chống clickjacking (kẻ tấn công
  // phủ một lớp trong suốt lên nút "Duyệt" và chờ người dùng bấm).
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  // Không cho trình duyệt tự "sửa" nội dung — một file tải lên tên x.jpg chứa
  // HTML mà bị đoán thành text/html thì thành XSS.
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  // CSP: không inline script. Đây là hàng phòng thủ cuối nếu có một chỗ quên
  // escape dữ liệu — engine in đã escape mọi thứ, nhưng không nên chỉ dựa vào đó.
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '),
};

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const origin = req.headers.get('origin');
  const allowed = allowedOrigins();

  // --- CORS ----------------------------------------------------------------
  // Không bao giờ phản chiếu origin của request kèm credentials. Đó chính là
  // cách viết ra `Access-Control-Allow-Origin: *` trá hình.
  if (origin && allowed.includes(origin)) {
    res.headers.set('Access-Control-Allow-Origin', origin);
    res.headers.set('Access-Control-Allow-Credentials', 'true');
    res.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.headers.set('Vary', 'Origin');
  } else if (origin) {
    // Origin lạ: không set header nào. Trình duyệt sẽ tự chặn phản hồi.
    res.headers.set('Vary', 'Origin');
  }

  // Preflight
  if (req.method === 'OPTIONS' && origin) {
    if (!allowed.includes(origin)) {
      return new NextResponse(null, { status: 403 });
    }
    return new NextResponse(null, { status: 204, headers: res.headers });
  }

  // --- Security headers ----------------------------------------------------
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);

  // Không cache phản hồi API: phiếu lương hay bảng lương nằm trong cache của
  // proxy/CDN là rò rỉ dữ liệu giữa những người dùng khác nhau.
  if (req.nextUrl.pathname.startsWith('/api/')) {
    res.headers.set('Cache-Control', 'no-store');
  }

  return res;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
