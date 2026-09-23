#!/usr/bin/env bash
# =============================================================================
# setup.sh — cài đặt AMIS Platform từ máy trắng, MỘT LỆNH
# =============================================================================
#
#   sudo bash scripts/setup.sh
#
# Vì sao có file này: cài PostgreSQL thủ công vướng rất nhiều chỗ lặt vặt mà mỗi
# chỗ đều làm người cài bế tắc — chưa cài Postgres, có hai cluster nên sửa nhầm
# cái, mật khẩu băm kiểu md5 trong khi server đòi scram-sha-256, pg_hba.conf để
# `peer` nên qua TCP luôn trượt. Script này xử lý hết, và QUAN TRỌNG HƠN: nó làm
# theo đúng thứ tự và kiểm tra lại sau mỗi bước, thay vì để người dùng đoán.
#
# Chạy lại được nhiều lần (idempotent): bước nào đã xong thì bỏ qua.
#
# Script KHÔNG xoá dữ liệu. Nếu database đã có bảng rồi thì nó không động vào.
# =============================================================================

set -euo pipefail

# --- Màu (tắt nếu không phải terminal) ---------------------------------------
if [ -t 1 ]; then
  B=$'\033[1m'; G=$'\033[32m'; R=$'\033[31m'; Y=$'\033[33m'; N=$'\033[0m'
else
  B=''; G=''; R=''; Y=''; N=''
fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
info() { printf '%s▶%s %s\n'   "$B" "$N" "$1"; }
warn() { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
die()  { printf '\n%s✗ %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }

# Phải chạy từ thư mục gốc dự án (nơi có package.json), không phải từ chỗ khác.
cd "$(dirname "$0")/.."
[ -f package.json ] || die "Không thấy package.json. Chạy: sudo bash scripts/setup.sh"

DB_NAME="${DB_NAME:-amis_platform}"
DB_USER="${DB_USER:-amis}"
DB_PORT="${DB_PORT:-5432}"
DB_PASS="${DB_PASS:-AmisDb2026x}"

echo
printf '%s==============================================%s\n' "$B" "$N"
printf '%s  AMIS Platform — cài đặt tự động%s\n' "$B" "$N"
printf '%s==============================================%s\n' "$B" "$N"
echo

# -----------------------------------------------------------------------------
# 0. Cần quyền root để cài package và sửa cấu hình PostgreSQL
# -----------------------------------------------------------------------------
if [ "$(id -u)" -ne 0 ]; then
  die "Cần quyền root. Chạy:  sudo bash scripts/setup.sh"
fi

# `sudo -u postgres` sẽ rớt nếu user postgres không tồn tại, nên kiểm tra trước
# để báo lỗi dễ hiểu thay vì để sudo in ra "unknown user postgres".
PGUSER_EXISTS=0
id postgres >/dev/null 2>&1 && PGUSER_EXISTS=1

# -----------------------------------------------------------------------------
# 1. Cài PostgreSQL nếu chưa có
# -----------------------------------------------------------------------------
info "1/7  Kiểm tra PostgreSQL"

if [ "$PGUSER_EXISTS" -eq 1 ] && command -v psql >/dev/null 2>&1; then
  ok "Đã có sẵn: $(psql --version)"
else
  if command -v apt-get >/dev/null 2>&1; then
    info "    Cài bằng apt (Ubuntu/Debian)…"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq postgresql postgresql-contrib >/dev/null
  elif command -v dnf >/dev/null 2>&1; then
    info "    Cài bằng dnf (RHEL/Rocky/Alma)…"
    dnf install -y -q postgresql-server postgresql-contrib >/dev/null
    # RHEL không tự initdb như Debian
    [ -d /var/lib/pgsql/data/base ] || postgresql-setup --initdb >/dev/null
  else
    die "Không nhận ra trình quản lý package (cần apt-get hoặc dnf). Cài PostgreSQL thủ công rồi chạy lại."
  fi
  id postgres >/dev/null 2>&1 || die "Cài xong mà vẫn không có user postgres."
  ok "Đã cài: $(psql --version)"
fi

# -----------------------------------------------------------------------------
# 2. Đảm bảo service đang chạy
# -----------------------------------------------------------------------------
info "2/7  Khởi động service"

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now postgresql >/dev/null 2>&1 || true
  # Debian/Ubuntu đặt tên service theo cluster (postgresql@16-main)
  systemctl start 'postgresql@*' >/dev/null 2>&1 || true
fi

# Chờ server nghe cổng — không chờ thì lệnh sau trượt với lỗi khó hiểu.
for i in $(seq 1 30); do
  if sudo -u postgres psql -tAc 'select 1' >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" -eq 30 ] && die "PostgreSQL không khởi động được sau 30 giây. Xem: sudo journalctl -u postgresql -n 50"
done
ok "PostgreSQL đang chạy"

# -----------------------------------------------------------------------------
# 3. Tìm cluster giữ cổng mong muốn
#
#    ĐÂY LÀ CHỖ HAY HỎNG NHẤT. Máy có thể có NHIỀU cluster (postgresql-14 ở 5432,
#    postgresql-16 ở 5433…). `sudo -u postgres psql` không có -p sẽ vào cluster
#    MẶC ĐỊNH, có thể không phải cái đang nghe 5432 — và thế là sửa mật khẩu cho
#    user ở nhầm cluster, app vẫn không vào được.
#
#    Nên: hỏi thẳng cluster mặc định xem nó nghe cổng nào. Nếu không khớp thì tìm
#    cluster khác qua pg_lsclusters. Vẫn đi qua SOCKET (không -h) nên không bị đòi
#    mật khẩu của user postgres.
# -----------------------------------------------------------------------------
info "3/7  Xác định cluster giữ cổng $DB_PORT"

PSQL="sudo -u postgres psql -tA"
CURRENT_PORT="$($PSQL -c 'SHOW port;' 2>/dev/null || echo '')"

if [ "$CURRENT_PORT" = "$DB_PORT" ]; then
  ok "Cluster mặc định đã nghe cổng $DB_PORT"
else
  warn "Cluster mặc định nghe cổng ${CURRENT_PORT:-?}, cần cổng $DB_PORT"
  if command -v pg_lsclusters >/dev/null 2>&1; then
    info "    Các cluster trên máy:"
    pg_lsclusters | sed 's/^/      /'
  fi
  # Thử nối thẳng vào cổng cần dùng, vẫn qua socket
  if sudo -u postgres psql -h /var/run/postgresql -p "$DB_PORT" -tAc 'select 1' >/dev/null 2>&1; then
    PSQL="sudo -u postgres psql -h /var/run/postgresql -p $DB_PORT -tA"
    ok "Đã chuyển sang cluster ở cổng $DB_PORT"
  else
    warn "Không tìm thấy cluster nào ở cổng $DB_PORT."
    warn "Sẽ dùng cổng $CURRENT_PORT thay thế — nhớ sửa DATABASE_URL cho khớp."
    DB_PORT="$CURRENT_PORT"
    [ -n "$DB_PORT" ] || die "Không xác định được cổng PostgreSQL."
  fi
fi

HBA_FILE="$($PSQL -c 'SHOW hba_file;' 2>/dev/null || echo '')"

# -----------------------------------------------------------------------------
# 4. Ép mã hoá mật khẩu kiểu scram-sha-256 TRƯỚC khi đặt mật khẩu
#
#    Thứ tự ở đây là cố ý. Nếu password_encryption đang là md5 mà pg_hba đòi
#    scram-sha-256 thì mật khẩu băm kiểu md5 sẽ LUÔN trượt dù gõ đúng — và người
#    dùng sẽ nghĩ mình gõ sai, đổi đi đổi lại mãi. Hash cũ cũng KHÔNG tự chuyển,
#    nên phải ALTER USER lại sau khi đổi thiết lập.
# -----------------------------------------------------------------------------
info "4/7  Cấu hình xác thực"

ENC="$($PSQL -c 'SHOW password_encryption;' 2>/dev/null || echo '')"
if [ "$ENC" != "scram-sha-256" ]; then
  warn "password_encryption đang là '$ENC' — chuyển sang scram-sha-256"
  $PSQL -c "ALTER SYSTEM SET password_encryption = 'scram-sha-256';" >/dev/null
  $PSQL -c "SELECT pg_reload_conf();" >/dev/null
  sleep 1
  ok "Đã chuyển sang scram-sha-256"
else
  ok "password_encryption = scram-sha-256"
fi

# Đảm bảo pg_hba cho phép xác thực bằng mật khẩu qua TCP loopback.
# `peer` chỉ hoạt động qua socket; nếu dòng host ghi `peer` thì app nối qua
# 127.0.0.1 sẽ LUÔN trượt.
if [ -n "$HBA_FILE" ] && [ -f "$HBA_FILE" ]; then
  if grep -qE '^\s*host\s+all\s+all\s+127\.0\.0\.1/32\s+(peer|ident)\s*$' "$HBA_FILE"; then
    warn "pg_hba.conf đang dùng 'peer' cho 127.0.0.1 — đổi sang scram-sha-256"
    cp "$HBA_FILE" "$HBA_FILE.bak.$(date +%s)"
    sed -i -E 's/^(\s*host\s+all\s+all\s+127\.0\.0\.1\/32\s+)(peer|ident)(\s*)$/\1scram-sha-256\3/' "$HBA_FILE"
    sed -i -E 's/^(\s*host\s+all\s+all\s+::1\/128\s+)(peer|ident)(\s*)$/\1scram-sha-256\3/' "$HBA_FILE"
    $PSQL -c "SELECT pg_reload_conf();" >/dev/null
    ok "Đã sửa pg_hba.conf (bản gốc đã sao lưu)"
  else
    ok "pg_hba.conf đã cho phép xác thực mật khẩu qua loopback"
  fi
else
  warn "Không đọc được pg_hba_file — bỏ qua bước này"
fi

# -----------------------------------------------------------------------------
# 5. Tạo user và database (idempotent)
#
#    ALTER USER chạy cả khi user đã tồn tại, để mật khẩu luôn khớp .env sắp ghi.
# -----------------------------------------------------------------------------
info "5/7  Tạo user và database"

EXISTS="$($PSQL -c "SELECT 1 FROM pg_roles WHERE rolname = '$DB_USER';" 2>/dev/null || echo '')"
if [ "$EXISTS" = "1" ]; then
  ok "User '$DB_USER' đã có — đặt lại mật khẩu cho khớp .env"
else
  $PSQL -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null
  ok "Đã tạo user '$DB_USER'"
fi
$PSQL -c "ALTER USER $DB_USER WITH PASSWORD '$DB_PASS';" >/dev/null

DBEXISTS="$($PSQL -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" 2>/dev/null || echo '')"
if [ "$DBEXISTS" = "1" ]; then
  ok "Database '$DB_NAME' đã có — giữ nguyên dữ liệu"
else
  $PSQL -c "CREATE DATABASE $DB_NAME OWNER $DB_USER;" >/dev/null
  ok "Đã tạo database '$DB_NAME'"
fi

# Kiểm tra nối BẰNG CHÍNH user app sẽ dùng. Không kiểm tra ở đây thì lỗi sẽ hiện
# ra sau, ở drizzle-kit, dưới dạng một stack trace khó đọc.
if ! PGPASSWORD="$DB_PASS" psql -h 127.0.0.1 -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
      -tAc 'select 1' >/dev/null 2>&1; then
  die "Không nối được bằng user '$DB_USER' qua 127.0.0.1:$DB_PORT.
     Chẩn đoán:  sudo grep -vE '^\\s*#|^\\s*\$' '$HBA_FILE'
     Dòng 'host ... 127.0.0.1/32 ...' phải ghi scram-sha-256, không phải peer."
fi
ok "Nối được bằng user '$DB_USER' qua 127.0.0.1:$DB_PORT"

# -----------------------------------------------------------------------------
# 6. Sinh .env
# -----------------------------------------------------------------------------
info "6/7  Tạo .env"

if [ -f .env ]; then
  # BUG ĐÃ SỬA: bản cũ chỉ in ra "sửa DATABASE_URL thủ công nếu cần" rồi CHẠY TIẾP
  # sang db:setup với cái .env sai. Người dùng nhận về 28P01 ở drizzle-kit mà
  # không hiểu vì sao, vì script vừa mới báo "✓ Nối được" ở bước trước.
  #
  # Nay: THỬ cái DATABASE_URL đang có. Nối được thì giữ nguyên (không phá cấu hình
  # của người dùng). Không nối được thì sao lưu .env và chỉ thay ĐÚNG dòng
  # DATABASE_URL — JWT_SECRET và CORS_ORIGINS giữ nguyên, vì đổi JWT_SECRET sẽ làm
  # mọi token đang dùng mất hiệu lực.
  EXPECTED="postgresql://$DB_USER:$DB_PASS@127.0.0.1:$DB_PORT/$DB_NAME"
  EXISTING="$(grep -E '^[[:space:]]*DATABASE_URL=' .env | tail -1 | cut -d= -f2- || true)"

  if [ -n "$EXISTING" ] && psql "$EXISTING" -tAc 'select 1' >/dev/null 2>&1; then
    ok ".env đã có và DATABASE_URL nối được — giữ nguyên"
  else
    [ -n "$EXISTING" ] \
      && warn ".env có DATABASE_URL nhưng KHÔNG nối được: $(echo "$EXISTING" | sed -E 's#(://[^:]+:)[^@]+@#\1***@#')" \
      || warn ".env chưa có dòng DATABASE_URL"
    BAK=".env.bak.$(date +%s)"
    cp .env "$BAK"
    if grep -qE '^[[:space:]]*DATABASE_URL=' .env; then
      sed -i "s#^[[:space:]]*DATABASE_URL=.*#DATABASE_URL=$EXPECTED#" .env
    else
      printf 'DATABASE_URL=%s\n' "$EXPECTED" >> .env
    fi
    ok "Đã sửa DATABASE_URL trong .env (bản gốc: $BAK)"
  fi

  # .env sinh ra từ lần chạy trước có thể thuộc về root — user thường phải đọc được
  # nó thì `npm run dev` mới chạy.
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    chown "$SUDO_USER":"$(id -gn "$SUDO_USER")" .env 2>/dev/null || true
  fi
else
  JWT="$(openssl rand -base64 48 | tr -d '\n')"
  # requireJwtSecret() đòi tối thiểu 32 ký tự; base64 của 48 byte là 64 ký tự.
  cat > .env <<EOF
# Sinh tự động bởi scripts/setup.sh ngày $(date -Iseconds)
DATABASE_URL=postgresql://$DB_USER:$DB_PASS@127.0.0.1:$DB_PORT/$DB_NAME
JWT_SECRET=$JWT
CORS_ORIGINS=http://localhost:3100
EOF
  chmod 600 .env   # chứa secret — không cho user khác trên máy đọc
  # BUG ĐÃ SỬA: script chạy bằng sudo nên .env thuộc về ROOT với mode 600, và
  # user thường — người sẽ chạy `npm run dev` — KHÔNG ĐỌC ĐƯỢC nó. Lỗi này chỉ lộ
  # ra khi chạy script thật: mọi thứ trước đó đều xanh, rồi `npm run dev` chết với
  # "DATABASE_URL chưa được đặt" dù file .env nằm ngay đó.
  # SUDO_USER là user đã gõ lệnh sudo — trả .env về cho người đó.
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    chown "$SUDO_USER":"$(id -gn "$SUDO_USER")" .env
    ok "Đã tạo .env (chmod 600, chủ sở hữu $SUDO_USER)"
  else
    ok "Đã tạo .env (chmod 600)"
  fi
fi

# Cùng lỗi đó áp dụng cho node_modules: nếu npm install chạy dưới sudo thì user
# thường không ghi được vào đó, lần `npm install` sau sẽ báo EACCES.
if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
  [ -d node_modules ] && chown -R "$SUDO_USER":"$(id -gn "$SUDO_USER")" node_modules 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# 7. Cài package, tạo bảng, nạp dữ liệu mẫu
# -----------------------------------------------------------------------------
info "7/7  Cài dependency và tạo bảng"

if command -v npm >/dev/null 2>&1; then
  [ -d node_modules ] || npm install --no-audit --no-fund >/dev/null 2>&1

  # Script npm KHÔNG tự nạp .env, nên phải export thủ công.
  set -a; . ./.env; set +a

  info "    npm run db:setup"
  npm run db:setup 2>&1 | sed 's/^/      /'

  if [ "${SKIP_SEED:-0}" = "1" ]; then
    warn "SKIP_SEED=1 — bỏ qua nạp dữ liệu mẫu"
  else
    info "    npm run seed:all (12 nhân viên, 360 ngày công)"
    npm run seed:all 2>&1 | tail -20 | sed 's/^/      /'
  fi
else
  warn "Không có npm — bỏ qua. Cài Node.js >= 20 rồi chạy: npm install && npm run db:setup"
fi

# -----------------------------------------------------------------------------
echo
printf '%s==============================================%s\n' "$G" "$N"
printf '%s  XONG%s\n' "$G" "$N"
printf '%s==============================================%s\n' "$G" "$N"
echo
echo "  Chạy ứng dụng:"
echo "      npm run dev"
echo "      rồi mở http://localhost:3100"
echo
echo "  Đăng nhập:  admin / Amis@2026!   (bắt buộc đổi mật khẩu ở lần đầu)"
echo
echo "  Nếu là VPS không có trình duyệt, tạo tunnel từ máy bạn:"
# `who am i` trả RỖNG khi chạy dưới sudo (không có tty login), nên dòng hướng dẫn
# sẽ in ra "ssh -L … @<ip-server>" thiếu tên user. Dùng SUDO_USER trước.
LOGIN_USER="${SUDO_USER:-$(whoami)}"
echo "      ssh -L 3100:localhost:3100 $LOGIN_USER@<ip-server>"
echo "      rồi mở http://localhost:3100"
echo
echo "  Thông số database:"
echo "      user     : $DB_USER"
echo "      password : $DB_PASS   ← ĐỔI LẠI nếu máy này có người khác dùng"
echo "      port     : $DB_PORT"
echo "      database : $DB_NAME"
echo
