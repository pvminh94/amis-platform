'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Alert, Button, Field, inputCls } from '@/components/ui';
import { setAccessToken, api } from '@/lib/client-token';

type Stage = 'login' | 'change' | 'done';

/**
 * Form đăng nhập, kèm bước đổi mật khẩu bắt buộc.
 *
 * Hai bước nằm trong CÙNG một component vì chúng là một luồng: token nhận được
 * ở bước một có cờ `mcp`, và chính token đó được dùng để gọi đổi mật khẩu. Tách
 * ra hai trang thì phải chuyển token qua URL hoặc storage — thêm một chỗ để lộ.
 */
export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const submitLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Không dùng api() ở đây: 401 lúc đăng nhập là kết quả BÌNH THƯỜNG (sai
      // mật khẩu), không phải lý do để chuyển hướng.
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = (await res.json()) as {
        accessToken?: string;
        user?: { username: string; mustChangePassword?: boolean };
        error?: { code?: string; message?: string };
      };
      if (!res.ok || !data.accessToken) {
        setError(data.error?.message ?? `Lỗi ${res.status}`);
        return;
      }
      setToken(data.accessToken);
      if (data.user?.mustChangePassword) {
        setStage('change');
        return;
      }
      setAccessToken(data.accessToken);
      setStage('done');
      router.push(next || '/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không kết nối được máy chủ');
    } finally {
      setBusy(false);
    }
  };

  const submitChange = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      });
      const data = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setError(data.error?.message ?? `Lỗi ${res.status}`);
        return;
      }
      // Đổi mật khẩu thu hồi MỌI phiên, nên token cũ đã chết. Bắt buộc đăng
      // nhập lại — không thể "tiếp tục" bằng token vừa dùng.
      setStage('login');
      setPassword('');
      setNewPassword('');
      setError(null);
      setBusy(false);
      window.alert('Đã đổi mật khẩu. Mọi phiên cũ đã bị thu hồi — hãy đăng nhập lại.');
      return;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Không kết nối được máy chủ');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-sm">
      {stage === 'login' && (
        <form onSubmit={submitLogin} className="space-y-4">
          <Field label="Tên đăng nhập">
            <input
              className={inputCls}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              autoFocus
              required
            />
          </Field>
          <Field label="Mật khẩu">
            <input
              className={inputCls}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </Field>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" disabled={busy || !username || !password}>
            {busy ? 'Đang kiểm tra…' : 'Đăng nhập'}
          </Button>
        </form>
      )}

      {stage === 'change' && (
        <form onSubmit={submitChange} className="space-y-4">
          <Alert tone="warn">
            Tài khoản này <strong>bắt buộc đổi mật khẩu</strong> trước khi dùng. Đây
            là mật khẩu do quản trị viên đặt.
          </Alert>
          <Field label="Mật khẩu mới">
            <input
              className={inputCls}
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              autoFocus
              required
            />
          </Field>
          <p className="text-xs text-[var(--muted)]">
            Tối thiểu 10 ký tự, có chữ hoa, chữ thường và số. Sau khi đổi, mọi phiên
            đang mở sẽ bị thu hồi.
          </p>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" disabled={busy || !newPassword}>
            {busy ? 'Đang đổi…' : 'Đổi mật khẩu'}
          </Button>
        </form>
      )}
    </div>
  );
}
