import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AMIS Platform',
  description: 'Nền tảng ERP — tham số nghiệp vụ là dữ liệu, sửa luật không cần sửa code',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body className="min-h-screen antialiased">
        <header className="border-b border-[var(--border)] bg-[var(--panel)]">
          <div className="mx-auto flex max-w-6xl items-center gap-4 px-6 py-4">
            <a href="/" className="text-lg font-semibold tracking-tight">
              AMIS<span className="text-[var(--accent)]"> Platform</span>
            </a>
            <span className="text-xs text-[var(--muted)]">
              Tham số nghiệp vụ là dữ liệu — đổi luật không cần sửa code
            </span>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
