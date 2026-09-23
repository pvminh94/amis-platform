# Triển khai AMIS Platform

Tài liệu này dành cho người đưa hệ thống lên máy chủ thật. Nó ghi cả những chỗ
dễ chết thầm — những lỗi không hiện thành thông báo nào.

---

## 1. Yêu cầu

| | |
|---|---|
| Docker | 24+ |
| Docker Compose | v2 (`docker compose`, không phải `docker-compose`) |
| RAM | 1,5 GB tối thiểu (Postgres 1 GB + app 512 MB) |
| Đĩa | 5 GB |
| Kiến trúc | amd64 hoặc arm64 |

---

## 2. Khởi động

```bash
git clone <repo> && cd amis-platform
cp .env.docker.example .env
nano .env                      # ĐỔI MẬT KHẨU — xem mục 3
docker compose up -d --build
docker compose logs -f migrate # xem migration chạy
```

Compose **từ chối start** nếu `POSTGRES_PASSWORD` hoặc `JWT_SECRET` để trống
(`:?` trong `docker-compose.yml`). Đó là chủ ý: một hệ thống lương khởi động
được với mật khẩu mặc định là sự cố, không phải cấu hình.

Kiểm tra:

```bash
curl -s localhost:3000/api/health
# {"status":"ok","database":"ok","migrations":11}
```

Endpoint đó **có ping PostgreSQL**. Nếu DB chết, nó trả 503 — khác với việc chỉ
đo "Next.js có sống không", thứ sẽ báo xanh trong khi không ai đăng nhập được.

---

## 3. Biến môi trường

### Bắt buộc

| Biến | Ghi chú |
|---|---|
| `POSTGRES_PASSWORD` | Mật khẩu DB. Không có giá trị mặc định. |
| `JWT_SECRET` | Ký access token, ≥ 32 ký tự. Sinh: `openssl rand -base64 48` |

**Đổi `JWT_SECRET` làm mọi access token đang dùng mất hiệu lực ngay.** Đừng đổi
ngẫu nhiên khi đang có người dùng.

### Tuỳ chọn

| Biến | Mặc định | Ghi chú |
|---|---|---|
| `POSTGRES_DB` | `amis_platform` | |
| `POSTGRES_USER` | `amis` | |
| `APP_PORT` | `3000` | Cổng expose ra host |
| `SEED_ON_START` | `false` | `true` = nạp dữ liệu mẫu |
| `CORS_ORIGINS` | *(rỗng)* | Phân cách bằng dấu phẩy |

`CORS_ORIGINS` **rỗng nghĩa là không origin nào được phép** — mặc định an toàn.
Không dùng `*`: nghĩa là bất kỳ trang nào cũng gọi được API bằng cookie của
người dùng, tức là CSRF.

### `SEED_ON_START=true` làm gì

Nạp 12 nhân viên, 360 ngày công từ 763 quẹt thẻ, kỳ lương 09/2026, 6 người dùng
với mật khẩu `Amis@2026!` (bắt buộc đổi ở lần đăng nhập đầu), 4 cấu hình ngân
hàng và 11 tài khoản.

**Để `false` cho hệ thống thật.** Seed ghi đè tài khoản người dùng về mật khẩu
seed — bật nó trên một hệ thống đang chạy là đặt lại mật khẩu của mọi người.

---

## 4. Ba service và vì sao tách như vậy

```
db       postgres:18-alpine         dữ liệu, volume pgdata
migrate  image tầng BUILDER         one-shot: migration + ràng buộc + seed
app      image tầng RUNNER          Next.js standalone, chỉ phục vụ
```

**Vì sao `migrate` là service riêng, không nằm trong entrypoint của app:** nếu
migration nằm trong app thì một lần migrate lỗi để lại một container "đang
chạy" nhưng không dùng được, và mỗi lần app restart lại migrate lại. Tách ra
thì migrate lỗi = exit code khác 0, hiện ngay trong `docker compose ps`, và
`app` không start (nhờ `condition: service_completed_successfully`).

**Vì sao `migrate` dùng tầng builder:** `drizzle-kit` và `tsx` là
devDependency, không có trong standalone bundle của app. Nhét chúng vào image
chạy thật thì mất hết lợi ích của `output: 'standalone'`.

**Vì sao Postgres không expose cổng:** app nối qua mạng nội bộ Docker
(`db:5432`). Mở Postgres ra interface mạng là rủi ro không cần thiết, và máy
chủ rất dễ đã có Postgres khác ở 5432. Cần DB client thì tạo
`docker-compose.override.yml`:

```yaml
services:
  db:
    ports: ["127.0.0.1:5432:5432"]
```

rồi vào bằng SSH tunnel: `ssh -L 5432:127.0.0.1:5432 user@server`.

---

## 5. Thứ tự seed (đã kiểm chứng trên DB trắng)

```
seed:policies   VN_PIT · VN_BHXH · VN_SALARY · APPROVAL · PRINT · GL_MAP · SHIFT
seed:auth       20 quyền, 5 vai trò, 6 người dùng
seed:employees  12 nhân viên
seed:attendance 3 thiết bị, 11 ngày lễ 2026, hệ xoay, 762 quẹt → 360 ngày công
payroll         kỳ 09/2026
seed:report     định nghĩa báo cáo (cần bảng lương đã có số liệu)
seed:payment    4 cấu hình ngân hàng + 11 tài khoản + 1 lô UNC
```

**Thứ tự này không đổi được tuỳ ý.** Hai ràng buộc từng gây lỗi thật:

- `seed:attendance` cần nhân viên → phải sau `seed:employees`
- `payroll` **đọc** `daily_attendance` → phải sau `seed:attendance`

Xếp `payroll` trước `seed:attendance` thì bảng lương vẫn chạy ra số đẹp — trả
đủ 26 ngày công cho những ngày không ai chứng minh là đã làm, và script exit 0.
Nay `payroll` **từ chối chạy** khi kỳ không có chấm công, trừ khi bật
`ALLOW_NO_ATTENDANCE=true` (xem mục 8).

---

## 6. Sao lưu và khôi phục

```bash
# Sao lưu
docker compose exec db pg_dump -U amis -Fc amis_platform > backup-$(date +%F).dump

# Khôi phục
docker compose down
docker volume rm amis-platform_pgdata
docker compose up -d db
sleep 10
cat backup-2026-09-23.dump | docker compose exec -T db pg_restore -U amis -d amis_platform
```

**`pgdata` là volume named, không phải thư mục.** `docker compose down` KHÔNG
xoá nó; `docker compose down -v` thì CÓ — và đó là toàn bộ dữ liệu lương.

Lịch sử lương là thứ không thể tái tạo. Đặt cron sao lưu trước khi có người
dùng thật, không phải sau sự cố đầu tiên.

---

## 7. Nâng cấp

```bash
git pull
docker compose up -d --build      # build lại, migrate tự chạy
docker compose logs migrate
```

Migration của dự án này **chỉ thêm**, không xoá cột — `0010` là ví dụ: thêm cột
`NOT NULL` vào bảng đã có dữ liệu được viết thành ba bước (thêm nullable → điền
cho dòng cũ → siết `NOT NULL`), vì một lệnh `ADD COLUMN … NOT NULL` sẽ nổ ngay
trên bảng có sẵn dòng.

Nếu `migrate` exit khác 0, `app` sẽ **không** restart sang bản mới. Đọc
`docker compose logs migrate` trước khi thử lại.

---

## 8. Vận hành

```bash
docker compose ps                          # trạng thái + health
docker compose logs -f app
docker compose exec app node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(console.log)"

# Tính lại một kỳ lương
docker compose exec -e ALLOW_NO_ATTENDANCE=false migrate npm run payroll

# Chạy test trong container (cần tầng builder, vì tests/ bị .dockerignore loại)
docker compose run --rm migrate npm run verify
```

`ALLOW_NO_ATTENDANCE=true` cho phép tính lương một kỳ **không có chấm công**,
mọi người được tính đủ ngày công chuẩn. Chỉ dùng khi thật sự biết cả kỳ đó
không có dữ liệu máy chấm (ví dụ thiết bị hỏng cả tháng) — và nhớ rằng đó là
trả lương không có bằng chứng.

---

## 9. Reverse proxy + TLS

Compose không làm TLS. Đặt Nginx/Caddy trước nó:

```nginx
server {
    listen 443 ssl http2;
    server_name hrm.example.vn;

    ssl_certificate     /etc/letsencrypt/live/hrm.example.vn/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/hrm.example.vn/privkey.pem;

    # Bắt buộc: cookie refresh token là HttpOnly + Secure. Không có TLS thì
    # Secure không có tác dụng và token đi dạng văn bản thuần trên mạng.
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Rồi đặt `CORS_ORIGINS=https://hrm.example.vn` và `APP_PORT=3000` (chỉ bind
localhost nếu proxy chạy cùng máy).

---

## 10. Trước khi có người dùng thật

- [ ] `POSTGRES_PASSWORD` đã đổi, không phải giá trị trong `.env.docker.example`
- [ ] `JWT_SECRET` đã sinh bằng `openssl rand -base64 48`
- [ ] `SEED_ON_START=false`
- [ ] Đã đổi mật khẩu của cả 6 tài khoản seed (hệ thống bắt đổi ở lần đầu)
- [ ] `CORS_ORIGINS` đặt đúng origin thật, không phải `*`
- [ ] TLS đã bật ở reverse proxy
- [ ] Cron sao lưu `pg_dump` đã đặt
- [ ] Đã đọc mục 11

---

## 11. Những gì tài liệu này CHƯA kiểm chứng được

Bộ file Docker này được viết và kiểm chứng **từng phần trong một sandbox không
có Docker**. Nói rõ để người triển khai biết chỗ nào cần tự xác nhận:

**Đã kiểm chứng thật:**

- `output: 'standalone'` build được, `server.js` chạy được và phục vụ đúng:
  `/api/health` → 200 `{"status":"ok","database":"ok","migrations":11}`, mọi
  trang 200, static asset 200, `/api/auth/login` trả 401 từ DB thật (chứng tỏ
  `pg` + `drizzle-orm` + bcrypt được trace đúng vào bundle)
- `.next/static` **phải copy tay** vào standalone — Next không tự làm. Thiếu
  dòng đó thì mọi trang trả 200 nhưng trắng trơn, và không lỗi nào kêu lên.
  Đã copy trong Dockerfile.
- `docker/migrate.sh` chạy hết trên một **PostgreSQL trắng**, exit 0, và cho ra
  DB **giống hệt** DB phát triển: 25 bảng, 11 migration, 2 ràng buộc EXCLUDE,
  12 nhân viên, 763 quẹt, 360 ngày công, tổng chi phí kỳ lương **522.915.846 đ**,
  tổng lô thanh toán **407.724.352 đ** — khớp từng đồng
- `sh -n docker/migrate.sh` sạch

**CHƯA kiểm chứng (không có Docker trong sandbox):**

- `docker build` thật — các lệnh trong Dockerfile chưa từng chạy trong một layer
- Kích thước image thực tế
- `docker compose up` — thứ tự start, healthcheck, `service_completed_successfully`
- `HEALTHCHECK` dùng `node -e fetch(...)` chưa chạy trong container
- User `node` (uid 1000) có quyền ghi những chỗ cần ghi
- PostgreSQL 18-alpine image (sandbox dùng embedded-postgres 18.4, cùng phiên bản
  lớn nhưng không phải cùng image)

Chạy `docker compose up -d --build` trên máy có Docker và đọc
`docker compose logs migrate` là bước xác nhận đầu tiên.
