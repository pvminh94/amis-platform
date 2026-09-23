import { Card } from '@/components/ui';
import { LoginForm } from '@/components/login-form';
import { safeRedirectTarget } from '@/lib/safe-redirect';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Chốt đích ở MỘT chỗ có test, thay vì một biểu thức điều kiện viết vội trong
  // page — kiểm tra `startsWith('/') && !startsWith('//')` vẫn lọt `/\evil.com`.
  const target = safeRedirectTarget(next);

  return (
    <main className="mx-auto max-w-5xl px-6 py-16">
      <div className="mb-6 text-center">
        <h1 className="text-2xl font-semibold">Đăng nhập</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Access token 15 phút · refresh token trong cookie HttpOnly 14 ngày
        </p>
      </div>
      <Card title="Phiên làm việc">
        <LoginForm next={target} />
      </Card>
    </main>
  );
}
