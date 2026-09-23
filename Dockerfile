# ==============================================================================
# AMIS PLATFORM — production image
# ==============================================================================
# Ba tầng:
#   deps     cài dependencies, cache theo package*.json
#   builder  next build (có drizzle-kit + tsx + src/ để migrate và seed)
#   runner   CHỈ .next/standalone — image chạy thật
#
# Vì sao migrate/seed chạy ở tầng BUILDER chứ không trong app: `output:
# 'standalone'` chỉ trace đúng những gói server.js cần. drizzle-kit và tsx là
# devDependency nên KHÔNG có trong đó. Nhét chúng vào image chạy thật thì mất
# hết lợi ích của standalone; tách thành service `migrate` riêng thì app vẫn
# nhỏ mà migration vẫn chạy được.
# ==============================================================================

# ------------------------------------------------------------------------------
# TẦNG 1 — deps
# ------------------------------------------------------------------------------
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat: một số native module (bcrypt) cần glibc-compat trên Alpine
RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

# ------------------------------------------------------------------------------
# TẦNG 2 — builder
# ------------------------------------------------------------------------------
FROM node:20-alpine AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# Build KHÔNG cần DB. Nếu có route nào query lúc build thì nó đã phải là
# force-dynamic — mọi route trong repo này đều khai báo như vậy. Đặt biến giả
# ở đây để nếu sau này ai đó viết một route static có query thì build FAIL
# ngay tại đây, chứ không phải âm thầm bake số liệu cũ vào image.
ENV DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build_only

RUN npm run build

# ------------------------------------------------------------------------------
# TẦNG 3 — runner
# ------------------------------------------------------------------------------
FROM node:20-alpine AS runner
WORKDIR /app

RUN apk add --no-cache libc6-compat tini

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

# Standalone bundle: server.js + node_modules đã trace
COPY --from=builder --chown=node:node /app/.next/standalone ./
# Next KHÔNG tự copy static vào standalone — quên dòng này thì mọi trang trả
# 200 nhưng trắng trơn vì không tải được chunk JS. Không có lỗi nào kêu lên.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static

# Chạy bằng user `node` (uid 1000) có sẵn trong image — container bị breakout
# cũng không có quyền root.
USER node

EXPOSE 3000

# tini làm PID 1: chuyển SIGTERM xuống node đúng cách và dọn tiến trình mồ côi.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]

# Healthcheck gọi /api/health — endpoint đó CÓ ping PostgreSQL. Chỉ đo "Next có
# sống không" thì sẽ báo xanh trong khi DB đã chết và không ai đăng nhập được.
# Dùng chính node để gọi, không cài thêm curl/wget.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
