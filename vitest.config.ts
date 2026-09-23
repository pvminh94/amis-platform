import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * Không có file này thì mọi module dùng alias `@/...` sẽ nổ khi test, dù tsc
 * và Next.js đều compile sạch. tsconfig `paths` chỉ dành cho TypeScript và
 * Next — Vitest chạy trên Vite, và Vite đọc alias riêng của nó.
 *
 * Đây là loại lệch cấu hình âm thầm nhất: code chạy được, build được, chỉ
 * test là không import được.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
  },
});
