#!/bin/sh
# ==============================================================================
# docker/migrate.sh — chạy trong service `migrate` (tầng builder của Dockerfile)
# ==============================================================================
# Chạy migration + ràng buộc EXCLUDE, rồi (nếu SEED_ON_START=true) nạp dữ liệu
# mẫu. App chỉ start SAU khi script này exit 0.
#
# Vì sao migrate là một service riêng chứ không nằm trong entrypoint của app:
# nếu migrate nằm trong app thì một lần migrate lỗi để lại một container "đang
# chạy" nhưng không dùng được, và mỗi lần app restart lại migrate lại. Tách ra
# thì migrate lỗi = exit code khác 0, hiện ngay trong `docker compose ps`.
# ==============================================================================
set -eu

echo "[migrate] DATABASE_URL = $(printf '%s' "${DATABASE_URL:-}" | sed 's|://[^@]*@|://***@|')"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "[migrate] THIẾU DATABASE_URL" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Chờ DB. `depends_on: service_healthy` đã lo lần start đầu, nhưng:
#   - `pg_isready` báo ready TRƯỚC khi Postgres thật sự nhận query (lúc đang
#     recovery), nên app nối vào vẫn trượt
#   - `docker compose restart app` KHÔNG đánh giá lại depends_on
# Vòng lặp này rẻ và bỏ được cả hai trường hợp.
# ---------------------------------------------------------------------------
i=1
while [ "$i" -le 30 ]; do
  if node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 });
    c.connect().then(() => c.query("select 1")).then(() => c.end()).then(() => process.exit(0))
      .catch(() => { c.end().catch(() => {}); process.exit(1); });
  ' 2>/dev/null; then
    echo "[migrate] DB sẵn sàng"
    break
  fi
  echo "[migrate] chờ DB… ($i/30)"
  i=$((i + 1))
  sleep 2
done

if [ "$i" -gt 30 ]; then
  echo "[migrate] DB không sẵn sàng sau 60s — bỏ cuộc" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Migration. `drizzle-kit migrate` cần src/db/schema.ts (đọc từ drizzle.config.ts)
# và thư mục drizzle/ — cả hai có trong tầng builder.
# ---------------------------------------------------------------------------
echo "[migrate] áp dụng migration"
npm run db:migrate

# Ràng buộc EXCLUDE mà Drizzle chưa diễn đạt được. Idempotent.
echo "[migrate] áp dụng ràng buộc EXCLUDE + CHECK bổ sung"
npm run db:extras

# ---------------------------------------------------------------------------
# Seed — CHỈ khi bật cờ. Mặc định TẮT: một hệ thống thật không được tự nạp dữ
# liệu mẫu, và seed ghi đè tài khoản người dùng về mật khẩu seed.
# ---------------------------------------------------------------------------
if [ "${SEED_ON_START:-false}" = "true" ]; then
  echo "[migrate] SEED_ON_START=true — nạp dữ liệu mẫu"
  # Dùng đúng `npm run seed:all` — chuỗi đó ĐÃ được sắp theo thứ tự phụ thuộc
  # (seed:policies -> auth -> payroll -> report -> attendance -> payment). Không
  # liệt kê lại từng lệnh ở đây: hai chỗ phát biểu cùng một thứ tự là hai chỗ
  # sẽ lệch nhau.
  npm run seed:all
  echo "[migrate] seed xong — mật khẩu seed là Amis@2026!, bắt buộc đổi ở lần đăng nhập đầu"
fi

echo "[migrate] hoàn tất"
