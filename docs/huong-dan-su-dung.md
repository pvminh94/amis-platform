# HƯỚNG DẪN SỬ DỤNG AMIS PLATFORM — từng bước

> Cập nhật lần cuối: 23/09/2026 · commit `7049f55` · 27 commit · 824 test · **đã đẩy lên GitHub**
>
> **Mọi lệnh trong tài liệu này đã được chạy thật và ghi lại kết quả.** Chỗ nào
> chưa kiểm chứng được trong môi trường hiện tại đều ghi rõ là **CHƯA KIỂM
> CHỨNG** — đừng coi nó là đã chạy.

---

## MỤC LỤC

1. [Trả lời thẳng: dùng được chưa?](#1-trả-lời-thẳng-dùng-được-chưa)
2. [Chuẩn bị máy](#2-chuẩn-bị-máy)
3. [Cài đặt từ đầu](#3-cài-đặt-từ-đầu)
4. [Đăng nhập lần đầu](#4-đăng-nhập-lần-đầu)
5. [Đi từng trang](#5-đi-từng-trang)
6. [Quy trình nghiệp vụ đầy đủ](#6-quy-trình-nghiệp-vụ-đầy-đủ)
7. [Đổi luật mà không cần sửa code](#7-đổi-luật-mà-không-cần-sửa-code)
8. [Nối máy chấm công](#8-nối-máy-chấm-công)
9. [Chạy bằng Docker](#9-chạy-bằng-docker)
10. [Đẩy code lên Git](#10-đẩy-code-lên-git) — ✅ đã xong
11. [Kiểm tra sức khoẻ hệ thống](#11-kiểm-tra-sức-khoẻ-hệ-thống)
12. [Những gì CHƯA làm được](#12-những-gì-chưa-làm-được)
13. [Xử lý sự cố](#13-xử-lý-sự-cố)

---

## 1. Trả lời thẳng: dùng được chưa?

**Dùng được ở mức nội bộ, có giám sát. Chưa đủ để đưa lên internet cho khách
hàng thật.**

### Đã kiểm chứng chạy được (có bằng chứng HTTP thật)

| Hạng mục | Kết quả |
|---|---|
| `npm run verify` | **824/824 test, 25 file** · `tsc` 0 lỗi |
| `npm run build` | sạch |
| `/api/health` | `{"status":"ok","database":"ok","migrations":14}` |
| Trang không đăng nhập | **9/9 → 307 về `/login`**, rò rỉ 0 con số |
| Trang sau khi đăng nhập | **9/9 → 200** kèm dữ liệu thật |
| API không token | **401** ở mọi route nghiệp vụ |
| `demo:auth` / `rbac` / `approval` / `gl` / `payment` | 32/0 · 18/0 · 10/0 · 4/0 · 17/0 |

### Hai lỗ hổng nghiêm trọng vừa tìm thấy và **đã sửa** trong phiên này

Đây là phần quan trọng nhất của câu trả lời, vì nó nói lên mức tin cậy của hệ
thống **trước** phiên này:

**① Mọi trang RSC trả dữ liệu thật mà không cần đăng nhập.**
`curl localhost:3100/payroll` không kèm cookie vẫn ra tổng lương. `/attendance`
lộ 12 mã nhân viên, `/gl` lộ 50 con số tiền.
→ Sửa ở commit `43f968e`.

**② 6/23 API route không có bất kỳ kiểm tra quyền nào.**
Người **ẩn danh** gọi được:

```
GET  /api/policies                              → 200, 33.413 byte
GET  /api/reports/LUONG_THEO_BO_PHAN?format=csv → 200, CSV lương đầy đủ
POST /api/policies/VN_PIT/versions  {}          → 400 INVALID_PARAMS
POST /api/policies/…/activate                   → 400 VERSION_NOT_FOUND
POST /api/approvals/<uuid>          {}          → 400 UNKNOWN_ACTION
```

Ba mã **400** chính là bằng chứng: nếu quyền được kiểm tra trước thì phải là 401.
Nhận 400 nghĩa là request đã đi **xuyên qua** tầng xác thực vào tới kiểm tra
tham số — tức là chỉ cần gửi payload **đúng** là người ẩn danh **sửa được biểu
thuế, kích hoạt nó, và duyệt lương**. Không cần tài khoản.
→ Sửa ở commit `31f32d4`.

> **Vì sao 824 test không bắt được?** Vì mọi test đều gọi **service layer** hoặc
> gọi API **kèm token hợp lệ** — tức là chỉ đi qua con đường đã được canh. Bài
> học: phải **liệt kê các đường vào dữ liệu trước**, rồi mới viết test.

### Kết luận thực dụng

- **Dùng nội bộ ngay hôm nay**: được, sau khi đổi mật khẩu seed.
- **Đưa lên internet công khai**: **chưa**. Xem [mục 12](#12-những-gì-chưa-làm-được).
- **Bán cho khách**: cần thêm 4–6 tuần cho mục 12.

---

## 2. Chuẩn bị máy

| Thứ | Cần | Đã kiểm chứng với |
|---|---|---|
| Node.js | ≥ 20 | v20.20.2 |
| npm | ≥ 10 | 10.8.2 |
| PostgreSQL | kiểm chứng với **18**; bản thấp hơn **chưa kiểm chứng** | 18 |
| RAM | ≥ 2 GB | — |
| Docker | chỉ nếu chạy theo mục 9 | **CHƯA KIỂM CHỨNG** |

Kiểm tra nhanh:

```bash
node -v      # phải >= v20
npm -v
psql --version
```

---

## 3. Cài đặt từ đầu

Toàn bộ lệnh chạy trong thư mục dự án. **Đừng bỏ qua bước nào** — thứ tự seed có
phụ thuộc.

### Bước 1 — Lấy code

```bash
git clone https://github.com/pvminh94/amis-platform.git
cd amis-platform
npm install
```

### Bước 2 — Cài PostgreSQL (nếu chưa có) rồi tạo database

#### 2a. Kiểm tra đã có chưa

```bash
id postgres          # "unknown user postgres" => CHƯA cài
which psql
systemctl status postgresql 2>/dev/null | head -3
```

Nếu `id postgres` báo **`unknown user postgres`** thì PostgreSQL chưa được cài —
user hệ thống `postgres` là do package PostgreSQL tạo ra. **Phải cài trước**, nếu
không lệnh `sudo -u postgres psql` bên dưới sẽ thất bại với đúng lỗi đó.

> Máy đang chạy ERPNext thường chỉ có **MariaDB**, không có PostgreSQL — hai cái
> này không thay thế được nhau.

#### 2b. Cài

**Ubuntu / Debian:**

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

**RHEL / Rocky / Alma / CentOS:**

```bash
sudo dnf install -y postgresql-server postgresql-contrib
sudo postgresql-setup --initdb
sudo systemctl enable --now postgresql
```

Kiểm tra lại — **phải thấy user `postgres` và service đang chạy:**

```bash
id postgres                              # kỳ vọng: uid=... (postgres)
sudo systemctl is-active postgresql      # kỳ vọng: active
psql --version
```

> **Về phiên bản:** hướng dẫn này được kiểm chứng với **PostgreSQL 18**. Ubuntu
> 22.04 cài mặc định bản 14, 24.04 bản 16 — **chưa kiểm chứng** trên các bản đó,
> nhưng schema chỉ dùng những tính năng rất cũ (`EXCLUDE`, chỉ mục unique từng
> phần, `jsonb`, `numeric`, `timestamptz`) nên nhiều khả năng chạy được. Nếu muốn
> chắc chắn, thêm repo PGDG:
> ```bash
> sudo apt install -y curl ca-certificates
> sudo install -d /usr/share/postgresql-common/pgdg
> sudo curl -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
>   https://www.postgresql.org/media/keys/ACCC4CF8.asc
> echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
>   https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" \
>   | sudo tee /etc/apt/sources.list.d/pgdg.list
> sudo apt update && sudo apt install -y postgresql-18
> ```

#### 2c. Tạo user và database

```bash
sudo -u postgres psql <<'SQL'
CREATE USER amis WITH PASSWORD 'doi-mat-khau-that-manh';
CREATE DATABASE amis_platform OWNER amis;
SQL
```

> `doi-mat-khau-that-manh` ở đây là **chỗ để bạn điền mật khẩu thật**, không phải
> chuỗi nên gõ nguyên văn. Nhớ dùng **đúng mật khẩu đó** trong `DATABASE_URL` ở
> Bước 3.

Kiểm tra nối được **bằng chính user `amis`** (không phải `postgres`):

```bash
psql "postgresql://amis:doi-mat-khau-that-manh@127.0.0.1:5432/amis_platform" -c 'select 1;'
# kỳ vọng in ra một dòng có số 1
```

Nếu báo `password authentication failed`: sửa `pg_hba.conf` để cho phép `scram-sha-256`
qua TCP, rồi `sudo systemctl reload postgresql`.

#### 2d. (Cách khác) Không cài Postgres, dùng Docker

`docker-compose.yml` đã kèm sẵn `postgres:18-alpine`, nên nếu máy có Docker thì
**bỏ qua cả Bước 2 lẫn Bước 4** và nhảy thẳng tới [mục 9](#9-chạy-bằng-docker).

### Bước 3 — Tạo file `.env`

```bash
cp .env.example .env
```

Mở `.env` và điền **đủ 3 biến**:

```bash
# Chuỗi nối PostgreSQL. ĐỔI MẬT KHẨU.
DATABASE_URL=postgresql://amis:doi-mat-khau-that-manh@127.0.0.1:5432/amis_platform

# Bí mật ký JWT (HS256), tối thiểu 32 ký tự. Sinh bằng:
#   openssl rand -base64 48
# ĐỔI secret này = mọi access token đang dùng mất hiệu lực ngay lập tức.
JWT_SECRET=<dán kết quả openssl rand -base64 48>

# Origin được phép gọi API từ trình duyệt, phân cách bằng dấu phẩy.
# Để TRỐNG = không origin nào được phép (mặc định an toàn).
# KHÔNG dùng '*': nghĩa là bất kỳ trang nào cũng gọi được API bằng cookie của
# người dùng — đúng định nghĩa CSRF.
CORS_ORIGINS=http://localhost:3100
```

> `.env.example` hiện chỉ có 1 dòng. Ba biến trên là **đầy đủ** những gì code
> đọc khi chạy thường (đã rà bằng `grep process.env`). Bốn biến khác —
> `ALLOW_NO_ATTENDANCE`, `ALLOW_REPAID_PERIOD`, `DEMO_BASE_URL` — chỉ dùng cho
> script, và các biến `POSTGRES_*` / `APP_PORT` / `SEED_ON_START` chỉ dùng cho
> Docker.

### Bước 4 — Tạo bảng

```bash
npm run db:setup
```

Lệnh này = `drizzle-kit migrate` (14 file migration) **+** `apply-extras.mjs`
(2 ràng buộc `EXCLUDE` và 4 chỉ mục unique từng phần mà Drizzle 0.36.4 không
diễn đạt được).

**Kết quả đúng:**

```
✓ 2 ràng buộc EXCLUDE đã áp dụng (by_kind + by_code)
```

Kiểm tra lại:

```bash
curl -s localhost:3100/api/health
# kỳ vọng: {"status":"ok","database":"ok","migrations":14}
```

> Nếu `migrations` ≠ 14 thì migration chưa chạy đủ — **dừng lại**, đừng seed.

### Bước 5 — Nạp dữ liệu mẫu (đúng thứ tự)

```bash
npm run seed:all
```

`seed:all` chạy **theo thứ tự cố định** — tự viết lại thứ tự sẽ hỏng vì seed sau
đọc dữ liệu seed trước:

```
seed:policies → seed:auth → seed:employees → seed:attendance
  → payroll → seed:report → seed:payment
```

**Kết quả đúng** (số liệu đã ổn định qua nhiều lần seed lại):

| Chỉ tiêu | Giá trị |
|---|---|
| Nhân viên | 12 |
| Ngày công | 360 |
| Lượt chấm | 753 (411 có GPS, 7 giả lập) |
| Nghỉ lễ 2026 | 11 ngày |
| Gross kỳ 09/2026 | **475.269.873 đ** |
| BH người lao động | 22.428.606 đ |
| Thuế TNCN | 21.076.485 đ |
| Thực nhận | **429.664.782 đ** |
| BH doanh nghiệp | 45.925.244 đ |
| Tổng chi phí | **521.195.117 đ** |

> **Muốn hệ thống sạch, không có dữ liệu mẫu?** Chỉ chạy `npm run seed:policies`
> và `npm run seed:auth`. Đừng chạy phần còn lại.
>
> **`run-payroll.ts` cố ý `exit 1`** nếu kỳ chưa có ngày công (trừ khi
> `ALLOW_NO_ATTENDANCE=true`) hoặc kỳ đã có lô thanh toán SENT/RETURNED (trừ khi
> `ALLOW_REPAID_PERIOD=true`). Đó là chốt an toàn, không phải lỗi.

### Bước 6 — Chạy

```bash
npm run dev        # phát triển, cổng 3100
# hoặc
npm run build && npm start    # production, cũng cổng 3100
```

Mở <http://localhost:3100>. **Phải bị đẩy về `/login`.** Nếu vào thẳng được trang
nào đó thì có gì sai — dừng lại.

---

## 4. Đăng nhập lần đầu

### Tài khoản seed

Mật khẩu chung: **`Amis@2026!`**

| Username | Họ tên | Vai trò | Phạm vi | Số quyền |
|---|---|---|---|---|
| `admin` | Quản trị hệ thống | ADMIN | COMPANY | 20 |
| `hr.admin` | Trần Nhân Sự | HR_ADMIN | COMPANY | 13 |
| `kt.truong` | Lê Kế Toán | CHIEF_ACCOUNTANT | COMPANY | 10 |
| `tp.kythuat` | Phạm Kỹ Thuật | DEPT_HEAD | DEPARTMENT (Kỹ thuật) | 5 |
| `tp.ketoan` | Võ Kế Toán Phòng | DEPT_HEAD | DEPARTMENT (Kế toán) | 5 |
| `nv.kythuat` | Nguyễn Kỹ Thuật | EMPLOYEE | SELF | 2 |

**Tất cả đều có `mustChangePassword = true`.** Nghĩa là: **mọi API sẽ trả 401
`MUST_CHANGE_PASSWORD` cho tới khi bạn đổi mật khẩu.** Đây là chủ ý — đã kiểm
chứng bằng curl.

### Việc ĐẦU TIÊN phải làm: đổi mật khẩu

Đăng nhập bằng `admin` / `Amis@2026!`, hệ thống bắt đổi mật khẩu ngay.

> **Chính sách mật khẩu:** tối thiểu 10 ký tự, và **từ chối mọi mật khẩu chứa chữ
> `amis`** (không phân biệt hoa thường). Nên `Amis@2026!` **không** dùng lại làm
> mật khẩu mới được — đây là một mâu thuẫn sẵn có trong thiết kế seed, không phải
> lỗi của bạn.

Đổi mật khẩu sẽ **thu hồi TOÀN BỘ phiên** của người đó (đã kiểm chứng: trả về
`{"changed":true,"revokedSessions":2,"mustReLogin":true}`).

### Phân quyền — điểm cần nhớ nhất

**Tách nhiệm vụ (separation of duties) là cố ý:**

| Quyền | HR_ADMIN | CHIEF_ACCOUNTANT |
|---|---|---|
| `payroll:run` (tính lương) | ✅ | ❌ |
| `gl:post` (ghi sổ cái) | ❌ | ✅ |
| `payment:export` (xuất file ngân hàng) | ❌ | ✅ |

Nghĩa là **nhân sự không tự ghi sổ và không tự xuất tiền được**, và **kế toán
trưởng không tự tính lương được**. Nếu bạn thấy "sao tôi không bấm được" — rất
có thể đó là thiết kế, không phải lỗi. Đăng nhập bằng `admin` để làm cả hai.

**Toàn bộ 20 quyền:** `approval:act`, `attendance:compute`, `attendance:read`,
`employee:read`, `employee:write`, `gl:post`, `gl:read`, `payment:export`,
`payment:read`, `payroll:read`, `payroll:run`, `payroll:submit`, `policy:activate`,
`policy:read`, `policy:write`, `print:read`, `print:write`, `report:read`,
`report:write`, `user:manage`.

> **Quyền được đọc lại từ DB ở MỖI request**, không nằm trong token. Đổi quyền
> cho ai là có hiệu lực ngay, không cần người đó đăng nhập lại.

---

## 5. Đi từng trang

14 trang. Trừ `/login`, **tất cả đều đòi đăng nhập** (đã kiểm chứng 9/9 trả 307
khi không có cookie).

| Đường dẫn | Làm gì |
|---|---|
| `/` | Danh sách 13 loại chính sách nghiệp vụ — cửa ngõ vào phần "đổi luật" |
| `/login` | Đăng nhập + bắt đổi mật khẩu |
| `/attendance` | Bảng chấm công 360 ngày công; nút tính lại |
| `/payroll` | Danh sách kỳ lương. Mỗi kỳ **lưu lại bộ tham số luật đã áp dụng** |
| `/payroll/[id]` | Chi tiết một kỳ: từng phiếu lương, nút trình duyệt, ghi sổ, lô ngân hàng |
| `/payments` | Lô thanh toán ngân hàng + nút xuất file |
| `/approvals`, `/approvals/[id]` | Hàng đợi duyệt và chi tiết một yêu cầu |
| `/gl` | Sổ cái: bảng cân đối thử và các bút toán |
| `/reports`, `/reports/[code]` | Báo cáo định nghĩa bằng JSON trong DB |
| `/print` | Danh sách mẫu in (xem lưu ý ở [mục 12](#12-những-gì-chưa-làm-được)) |
| `/policies/[kind]` | Lịch sử phiên bản của một loại chính sách |
| `/policies/[kind]/new` | Form tạo phiên bản chính sách mới |

---

## 6. Quy trình nghiệp vụ đầy đủ

Đây là chuỗi thật, theo đúng thứ tự. **Mỗi bước đều cần quyền khác nhau.**

### Bước 1 — Tính lương

```bash
npm run payroll          # chạy kỳ hiện tại
```

Hoặc bấm ở `/payroll`. Trạng thái khởi tạo là **Draft**.

### Bước 2 — Trình duyệt

`/payroll/[id]` → nút **Trình duyệt** (cần `payroll:submit`).
Chuyển **Draft → Pending**. Lúc này vào hàng đợi `/approvals`.

### Bước 3 — Duyệt

`/approvals/[id]` → **Duyệt** / **Từ chối** / **Trả lại** (cần `approval:act`).

Chuỗi trạng thái: `Draft → Pending → Approved`, hoặc `Pending → Rejected`,
`Pending → Returned → Draft`. Mọi bước đều ghi **audit trail không xoá được**.

### Bước 4 — Ghi sổ cái

`/payroll/[id]` → **Ghi sổ** (cần `gl:post` — **chỉ kế toán trưởng hoặc admin**).

Sinh **3 bút toán** mỗi kỳ:

| Bút toán | Nợ | Có |
|---|---|---|
| `SALARY_ACCRUAL` | 6421 / 6422 / 154 | 334 (gross), 3383/3384/3386/3388 |
| `SALARY_DEDUCTION` | 334 | 3383/3384/3386, 3335, 141 |
| `SALARY_PAYMENT` | 334 | 1121 (net) |

**Bất biến quan trọng nhất: TK 334 phải ròng bằng 0.** Đã kiểm chứng:
`✓ BẰNG 0 — đã ghi nhận đủ, đã trừ đủ, đã trả đủ. Không treo khoản nào.`

Ghi lần hai sẽ bị chặn: `ALREADY_POSTED`. Và **giao dịch roll back sạch** — sổ
cái không đổi sau lần ghi thất bại (đã kiểm chứng).

### Bước 5 — Xuất file ngân hàng

`/payments` → chọn ngân hàng → **Xuất file** (cần `payment:export`).

| Ngân hàng | Định dạng |
|---|---|
| **VCB** | Fixed-width, CRLF, ASCII, số tiền 12 chữ số. Dòng `A\|` header, `D\|` chi tiết, `Z\|` tổng |
| **TCB / CTG / MBB** | CSV, khối header `#`, 9 cột, **có BOM**, số tài khoản dạng `"=""…"""` |

Số lô: `PR{YYYY}{MM}-{BANK}-{NN}` (≤ 40 ký tự, UNIQUE).

**Đối soát đã kiểm chứng:** tổng lô **406.681.904 đ** = 429.664.782 −
22.982.878 (NV012 chưa có số tài khoản) → in ra `✓ KHỚP`.

Chuỗi trạng thái lô: `GENERATED → {SENT, VOID}`, `SENT → {RETURNED, VOID}`,
`RETURNED → VOID`.

> **Tải file:** hệ thống lưu **nguyên văn bytes + SHA-256**. Nếu nội dung không
> khớp checksum, endpoint từ chối trả file. Nút "tải" đi qua token (không phải
> thẻ `<a href>` — cái đó nhận về 401, đã sửa ở commit `31f32d4`).

---

## 7. Đổi luật mà không cần sửa code

Đây là **lý do tồn tại** của nền tảng này.

### Nguyên tắc phân tách

| Loại | Nằm ở đâu | Đổi bằng cách |
|---|---|---|
| **Ổn định** (công thức, engine) | Code thật trong `src/engine/` | Sửa code + test |
| **Hay đổi** (thuế suất, trần BHXN, ca kíp, mẫu in, định nghĩa báo cáo) | **Database**, `policy_versions` | **Giao diện** |

### Các loại chính sách

**12 loại nghiệp vụ** (đã tra trong `policy_kinds`):
`VN_PIT`, `VN_BHXH`, `VN_SALARY`, `APPROVAL`, `PRINT`, `REPORT_DEF`, `SHIFT`,
`SHIFT_ROTATION`, `BANK_PAYOUT`, `GEOFENCE`, `GL_MAP`, `LIVENESS`.

Loại thứ 13 trong bảng là `TEST_PIT` — chỉ phục vụ test, không phải nghiệp vụ.

Mỗi loại có **phạm vi loại trừ riêng**:

- **Theo loại**: `VN_PIT`, `VN_BHXH`, `VN_SALARY`, `APPROVAL`, `GL_MAP`, `LIVENESS`
- **Theo (loại, mã)**: `PRINT`, `REPORT_DEF`, `SHIFT`, `SHIFT_ROTATION`,
  `BANK_PAYOUT`, `GEOFENCE`

Hiệu lực theo **nửa khoảng `[from, to)`**. Nếu không tìm được phiên bản áp dụng,
engine **ném `NOT_RESOLVABLE`** chứ **không** âm thầm dùng mặc định.

### Ví dụ thật: đổi biểu thuế

1. Vào `/` → bấm **VN_PIT**
2. Bấm tạo phiên bản mới
3. Điền bậc thuế mới, `effectiveFrom` = ngày luật có hiệu lực
4. Tích "kích hoạt ngay" (cần `policy:activate`)

**Không cần deploy. Không cần sửa code.** Các kỳ lương **đã tính** vẫn tái hiện
đúng con số cũ, vì mỗi kỳ **lưu lại bộ tham số đã áp dụng**.

Chạy thử toàn bộ kịch bản này:

```bash
npm run demo
```

### Ràng buộc an toàn của báo cáo

Một định nghĩa báo cáo **không bao giờ chứa SQL**. Người dùng chỉ chọn từ danh
sách cột đã whitelist; engine ghép câu truy vấn từ những mảnh viết sẵn và **mọi
giá trị đi qua tham số `$1, $2…`**. `limit` tối đa 10.000. Không có đường nào để
một chuỗi nhập vào lọt thành mã SQL.

---

## 8. Nối máy chấm công

Hai webhook, hai giao thức:

| Endpoint | Giao thức | Máy |
|---|---|---|
| `POST /api/devices/adms` | ADMS/ADMS2 | Ronald Jack, ZKTeco |
| `POST /api/devices/hikvision` | ISAPI (JSON **hoặc** XML) | Hikvision |

### Cấu hình trên máy

Trỏ máy về `http://<địa-chỉ-server>:3100/api/devices/adms` kèm **khoá riêng của
máy đó** (`shift_devices.webhook_key`).

### Cách xác thực — đọc kỹ

**Thiết bị KHÔNG dùng JWT.** Mỗi máy có một khoá riêng, so bằng
`timingSafeEqual`. Ba lý do từ chối trả **ba mã khác nhau** để biết đang hỏng ở
đâu.

> **Khoá demo nằm trong `scripts/roster.ts` (`DEVICE_WEBHOOK_KEYS`) — ĐỔI TRƯỚC
> KHI DÙNG THẬT.**

### Cách máy được nhận ra

`employees.device_user_id` ánh xạ **PIN trên máy → nhân viên**. Đây là chỉ mục
**unique từng phần** (`WHERE device_user_id IS NOT NULL`) — hai nhân viên cùng để
trống không đụng nhau.

### Ba lỗi giao thức đã sửa — đừng tái phạm

1. **`SET_TIME` gửi giờ UTC** cho máy đang chờ giờ địa phương → đồng hồ bị đặt
   lùi 7 tiếng. **Máy vẫn chạy bình thường**, chỉ có giờ là sai. Phát hiện bằng
   cách cho set rồi đọc lại.
2. **Ném lỗi khi thiếu `dateTime`** → trả 500 → **máy retry vô hạn**. Phải trả
   **400**.
3. **`Number(x) || 0`** biến `workCode` rác thành `0` = PASSWORD; còn
   `Number(x) || undefined` **làm mất số 0 thật**.

### Đã kiểm chứng bằng curl thật

| Tình huống | Kết quả |
|---|---|
| ADMS 3 hợp lệ + 1 PIN lạ + 1 dòng hỏng | `inserted 2, skipped 1, unmatched 1` |
| Gửi lại y nguyên | `inserted 0, duplicates 2` |
| Sai khoá / máy không tồn tại / thiếu khoá | **401 cả ba** |
| Hikvision JSON | inserted 1 · gửi lại → duplicates 1 |
| Hikvision XML | inserted 1 |
| `subEventType 34` | "Sai khuôn mặt", không ghi lượt |
| Body rác | **400** (không phải 500) |

### Kiểm tra GPS / geofence

```bash
npm run check:locations 2026-09-01 2026-09-30
```

**Kết quả thật:** 411 lượt chấm di động →
**TRUSTED 340 (82.7%) · REVIEW 35 · REJECTED 36 · NO_FENCE 0 · NO_GPS 0**
Từ chối: `OUTSIDE_HARD_RADIUS` 26, `MOCK_LOCATION` 7, `ACCURACY_TOO_LOW` 3.

---

## 9. Chạy bằng Docker

> ⚠️ **CHƯA KIỂM CHỨNG.** Môi trường hiện tại **không có Docker**. Các file dưới
> đây tồn tại và đã được rà soát, nhưng **chưa có lệnh `docker build` nào chạy
> thành công ở đây**. Hãy coi phần này là bản nháp cần bạn tự chạy thử.
>
> Những gì **đã** kiểm chứng: `docker/migrate.sh` chạy trên PostgreSQL trắng cho
> ra đúng DB dev (25 bảng, 2 EXCLUDE, 4 chỉ mục unique từng phần, 12 nhân viên,
> 360 ngày công); bundle standalone **84 MB**.

```bash
cp .env.docker.example .env
# SỬA: POSTGRES_PASSWORD và JWT_SECRET
#   openssl rand -base64 48
docker compose up -d --build
```

Compose có 3 service: `db` (postgres:18-alpine), `migrate` (chạy một lần rồi
thoát), `app`.

**`POSTGRES_PASSWORD` để trống thì compose TỪ CHỐI start** (dùng `:?`). Đó là chủ
ý: một DB lương với mật khẩu mặc định là sự cố, không phải cấu hình.

**`SEED_ON_START=true`** nạp dữ liệu mẫu ở lần start đầu. **Để `false` cho hệ
thống thật.**

Chi tiết đầy đủ: [`docs/deployment.md`](deployment.md).

---

## 10. Đẩy code lên Git

### ✅ Đã đẩy xong — 23/09/2026

```
To https://github.com/pvminh94/amis-platform.git
   7e75b13..7049f55  main -> main
```

**Repo:** <https://github.com/pvminh94/amis-platform> (private)

**Đã kiểm chứng bằng cách hỏi thẳng GitHub API**, không chỉ tin output của git:

| Kiểm tra | Kết quả |
|---|---|
| HEAD trên remote | `7049f55` — **bằng** local HEAD |
| Số commit | remote **27** = local **27** |
| `docs/huong-dan-su-dung.md` | HTTP **200** |
| `src/lib/page-auth.ts` | HTTP **200** |
| `.env` | HTTP **404** — đúng, secret không bị đẩy lên |

Đây là **fast-forward thật**, không phải force push: remote trước đó ở `7e75b13`
(một commit cũ của chính lịch sử này), và đã xác nhận bằng
`git merge-base --is-ancestor origin/main HEAD` trước khi đẩy. Không mất commit nào.

> **Lưu ý về môi trường sandbox:** `.git/config` nằm trong nhóm file **bị loại
> khỏi snapshot** (cùng `.git/credentials`, `.netrc` — vì chứa thông tin nhạy cảm).
> Nên remote đã cấu hình **sẽ mất** khi môi trường khởi động lại, và lần sau phải
> cấu hình lại. Đây là lý do ở các phiên trước lệnh push thất bại với
> `'origin' does not appear to be a git repository`.

### Cấu hình lại remote ở môi trường mới

```bash
cd amis-platform
git remote add origin https://github.com/pvminh94/amis-platform.git
git push -u origin main          # sẽ hỏi credential
```

Hoặc clone từ máy bạn:

```bash
git clone https://github.com/pvminh94/amis-platform.git
```

### Về credential

Push lần này dùng một personal access token **được dán trực tiếp vào hội thoại**.
Token đó đã được **gỡ khỏi `.git/config`** ngay sau khi push, và đã quét xác nhận:

```
file trong repo chứa token:      0
bundle chứa token:               0
số lần xuất hiện trong lịch sử git: 0
```

> ⚠️ **Nhưng token đã nằm trong lịch sử hội thoại.** Hãy **thu hồi nó** ở
> <https://github.com/settings/tokens> và tạo token mới khi cần. Đừng dùng lại.
>
> Nguyên tắc cho lần sau: đừng dán token vào chat. Cấu hình credential helper ở
> máy bạn (`git config --global credential.helper store` hoặc dùng SSH key), rồi
> push từ đó.

### Bundle dự phòng

Vẫn giữ `/home/user/amis-platform-full.bundle` (641 KB, 27 commit, nhánh `main`)
phòng khi cần chuyển lịch sử sang máy khác mà không qua mạng:

```bash
git clone amis-platform-full.bundle amis-platform
```

### Lịch sử 27 commit (mới nhất trước)

```
7049f55 docs: hướng dẫn sử dụng từng bước + đánh giá trung thực mức dùng được
31f32d4 fix(security): khoá 6 API route không có kiểm tra quyền
43f968e fix(security): bảo vệ các trang RSC
36dbd38 feat(17): parser giao thức thiết bị — ADMS + Hikvision ISAPI
6f56d6d Phase 16: geofence + liveness
… (27 commit tổng cộng)
```

---

## 11. Kiểm tra sức khoẻ hệ thống

Chạy **theo thứ tự này** mỗi khi nghi ngờ có gì hỏng.

```bash
# 1. Toàn bộ — typecheck + migration + 824 test
npm run verify
# kỳ vọng: Test Files 25 passed (25) · Tests 824 passed (824)

# 2. Build production
npm run build
# kỳ vọng: ✓ Compiled successfully

# 3. Server sống và nối được DB
curl -s localhost:3100/api/health
# kỳ vọng: {"status":"ok","database":"ok","migrations":14}

# 4. Các luồng HTTP thật (cần server đang chạy)
npm run demo:auth       # 32 đạt · 0 hỏng
npm run demo:rbac       # 18 đạt · 0 hỏng
npm run demo:approval   # 10 ✓
npm run demo:gl         #  4 ✓ · "Tất cả kiểm tra đạt."
npm run demo:payment    # 17 đạt / 0 hỏng
```

### Kiểm tra bảo mật — **nên chạy định kỳ**

Đây chính là cách tìm ra hai lỗ hổng ở mục 1. Chạy khi **server đang chạy**:

```bash
# A) Không trang nào được vào nếu chưa đăng nhập — phải là 307 tất cả
for p in / /payroll /attendance /payments /gl /reports /approvals /policies/VN_PIT; do
  printf "  %s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' localhost:3100$p)" "$p"
done
# kỳ vọng: 307 ở cả 8 dòng. Nếu thấy 200 là CÓ LỖ HỔNG.

# B) Không API nghiệp vụ nào mở — phải là 401 tất cả
for u in /api/policies /api/reports/LUONG_THEO_BO_PHAN?format=csv; do
  printf "  %s  %s\n" "$(curl -s -o /dev/null -w '%{http_code}' "localhost:3100$u")" "$u"
done
# kỳ vọng: 401 ở cả 2 dòng.

# C) Endpoint cố ý mở vẫn phải mở
curl -s -o /dev/null -w "  %{http_code}  /api/health (kỳ vọng 200)\n" localhost:3100/api/health

# D) Rà nhanh route nào quên kiểm tra quyền
for f in $(find src/app/api -name route.ts | sort); do
  r=${f#src/app/}; r=${r%/route.ts}
  grep -qE "requirePermission|authenticate\(|authenticateDevice" "$f" \
    || echo "  >>> $r KHÔNG CÓ KIỂM TRA QUYỀN"
done
# kỳ vọng (đã chạy thật, đúng 4 dòng này và KHÔNG có dòng nào khác):
#   >>> api/auth/login
#   >>> api/auth/logout
#   >>> api/auth/refresh
#   >>> api/health
# devices/* không hiện vì xác thực bằng authenticateDevice.
# Nếu thấy THÊM dòng nào khác → có route mới quên kiểm tra quyền.
```

> **Mẹo chẩn đoán quan trọng:** khi nghi một endpoint, **đừng gửi payload đúng**
> (sẽ sửa dữ liệu thật). Hãy gửi payload rác `{}` rồi **đọc mã lỗi**:
> - **401** → tốt, quyền được kiểm tra trước.
> - **400** → **có lỗ hổng**: request đã đi qua tầng xác thực vào tới kiểm tra
>   tham số. Chỉ cần payload đúng là ghi được.

Hai test chốt hạ, chạy trong `npm run verify`:

| Test | Số lượng | Chặn gì |
|---|---|---|
| `tests/page-auth.spec.ts` | 25 | Trang mới quên `requirePageSession()`; thẻ `<a href="/api/…">` |
| `tests/api-auth.spec.ts` | 42 | API route mới quên `requirePermission` — **whitelist ngược**: mặc định phải có, muốn mở phải khai kèm lý do |

Cả hai **đã được chứng minh là bắt được lỗi** bằng cách cố tình bỏ dòng kiểm tra
rồi xác nhận test đỏ, khôi phục rồi xác nhận xanh.

---

## 12. Những gì CHƯA làm được

Nói thẳng, không giảm nhẹ.

### Chặn việc đưa lên internet

| Vấn đề | Mức độ | Ghi chú |
|---|---|---|
| **Khoá webhook demo đang nằm trong code** | 🔴 Cao | `DEVICE_WEBHOOK_KEYS` trong `scripts/roster.ts`. Phải chuyển sang DB/env |
| **Mật khẩu seed `Amis@2026!` ai cũng biết** | 🔴 Cao | Bắt buộc đổi. Và chính sách mật khẩu **từ chối mọi mật khẩu chứa `amis`**, nên không đổi lại thành chính nó được — mâu thuẫn sẵn có |
| **Docker chưa kiểm chứng** | 🟡 Trung bình | Không có Docker trong môi trường này |
| **Không có HTTPS/TLS** | 🟡 Trung bình | Cần reverse proxy (Caddy/Nginx) phía trước |
| **`CORS_ORIGINS` mặc định rỗng** | 🟢 Thấp | An toàn, nhưng phải điền trước khi gọi API từ trình duyệt |

### Thiếu tính năng

| Thiếu | Ảnh hưởng |
|---|---|
| **`/print` chỉ LIỆT KÊ mẫu in** | Đã kiểm chứng: trang in ra **bảng danh sách**, không render tài liệu. Không có `window.print()`, không có CSS `@media print` ở bất kỳ đâu. Muốn in phiếu lương thì **chưa in được từ giao diện** |
| **Chưa xuất PDF** | Engine in sinh HTML. Chromium **không có** trong môi trường này nên chưa kiểm chứng được đường ra PDF. ERPNext cũng làm giống vậy (để trình duyệt tạo PDF) — nên hướng đi là đúng, chỉ chưa nối |
| **Chưa có trang quản lý người dùng** | Thêm/sửa người dùng phải làm trực tiếp trong DB. Quyền `user:manage` tồn tại nhưng chưa có UI |
| **Chưa có trang quản lý nhân viên** | `employee:write` tồn tại nhưng chưa có UI |
| **Chỉ có 1 công ty** | Chưa đa công ty (multi-tenant) |

### Nợ kỹ thuật

- `.env.example` chỉ có 1 dòng (thiếu `JWT_SECRET`, `CORS_ORIGINS`) — tài liệu này
  bù vào, nhưng nên sửa file.
- 12 loại chính sách nghiệp vụ nhưng **thêm loại mới vẫn cần 1 dòng code** (`VALIDATORS`),
  không phải hoàn toàn zero-code như mục tiêu ban đầu.

---

## 13. Xử lý sự cố

### `npm run db:setup` báo lỗi kết nối

Kiểm tra `DATABASE_URL` trong `.env`. **Lệnh `tsx` và npm script KHÔNG tự nạp
`.env`** — nếu chạy script tay:

```bash
set -a; . ./.env; set +a
npm run seed:all
```

### Trang nào cũng bị đẩy về `/login` sau khi đăng nhập

Cookie phiên `access_token` sống **900 giây (15 phút)**. Nếu client không gọi
`/api/auth/refresh` để làm mới, trang sẽ hết hạn trong khi API vẫn chạy.
Route refresh **có** cấp lại cookie — đã kiểm chứng cả hai cookie được đặt:

```
set-cookie: refresh_token=…; HttpOnly; Path=/api/auth; Max-Age=1209600; SameSite=Lax
set-cookie: access_token=…;  HttpOnly; Path=/;         Max-Age=900;     SameSite=Lax
```

> Nếu bạn tự thêm chỗ set cookie: **phải dùng `Headers.append`**, không dùng
> object. Một object chỉ giữ được **một** giá trị cho cùng tên header — cookie
> thứ hai sẽ **âm thầm ghi đè** cookie thứ nhất, không có lỗi nào kêu lên.

### API trả 401 `MUST_CHANGE_PASSWORD`

Đúng như thiết kế. Đổi mật khẩu trước. **Mọi phiên sẽ bị thu hồi**, phải đăng
nhập lại.

### Nút "tải" không tải được

Phải là nút do `AuthDownload` / `BatchDownload` render. Nếu bạn thấy thẻ
`<a href="/api/…">` ở đâu đó thì **nó sẽ luôn trả 401** — test
`page-auth.spec.ts` sẽ đỏ và chỉ ra file.

### Kỳ lương tính ra toàn 0

`run-payroll.ts` **cố ý `exit 1`** nếu kỳ chưa có ngày công. Đây là chốt an toàn
(một lần nó đã âm thầm trả lương cả tháng dù không có ngày công nào). Nếu thật sự
muốn bỏ qua: `ALLOW_NO_ATTENDANCE=true`.

### Kỳ đã trả tiền, muốn tính lại

Bị chặn nếu kỳ có lô SENT/RETURNED. Cần `ALLOW_REPAID_PERIOD=true`.

### Seed chạy hai lần ra số khác

Seed dùng **UPSERT** cho thiết bị. Nếu bạn đổi thứ tự RNG mà không dọn dữ liệu
cũ, sẽ có **hai bộ lượt chấm** (đã từng xảy ra: 763 → 1134). Chạy lại toàn bộ
`seed:all` từ đầu trên DB sạch.

### `git push` báo không có credential

Đúng như mục 10 — sandbox không giữ credential. Push từ máy bạn, hoặc dùng bundle.

### Môi trường khởi động lại, mọi thứ mất

`node_modules` và tiến trình **không** được lưu. `pgdata` **có** được lưu nhưng
**mất 13 thư mục rỗng**. Phục hồi:

```bash
cd amis-platform && npm install
cd /home/user/.pgtest/pgdata && mkdir -p pg_commit_ts pg_dynshmem \
  pg_logical/mappings pg_logical/snapshots pg_notify pg_replslot pg_serial \
  pg_snapshots pg_stat pg_stat_tmp pg_tblspc pg_twophase pg_wal/archive_status
chmod 700 . && rm -f postmaster.pid
cd .. && ./node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl \
  -D pgdata -l pg.log -o "-p 55555 -k /tmp" -w start
```

> **Đừng bao giờ `initdb`** — sẽ xoá sạch dữ liệu. **Đừng `pkill -f postgres`**.

### Identity git bị mất

```bash
IFS='|' read -r N E <<< "$(git log -1 --format='%an|%ae')"
git config user.name "$N"; git config user.email "$E"
```

---

## Phụ lục — lệnh hay dùng

```bash
npm run dev               # chạy dev, cổng 3100
npm run build && npm start # chạy production
npm run verify            # typecheck + migrate + 824 test
npm run test              # chỉ test
npm run typecheck         # chỉ tsc
npm run db:setup          # migrate + extras
npm run db:studio         # Drizzle Studio (xem DB bằng GUI)
npm run seed:all          # nạp toàn bộ dữ liệu mẫu (đúng thứ tự)
npm run payroll           # tính lương kỳ hiện tại
npm run check:locations   # kiểm tra GPS/geofence
npm run demo              # kịch bản "đổi luật" đầu-cuối
npm run demo:{auth,rbac,approval,gl,payment}   # 81 kiểm tra HTTP thật
```

### Cấu trúc thư mục

```
src/engine/    20 file — logic thuần, không biết DB là gì
               money formula pit si salary approval print report workflow
               gl auth time shift attendance payment-file geofence liveness
               adms hikvision
src/lib/       tầng nối — auth rbac payroll payslip gl payment location
               page-auth device-ingest cookies client-token safe-redirect
src/policy/    13 loại chính sách + registry.ts
src/db/        client.ts · schema.ts (25 bảng) · extras.sql
drizzle/       0000…0013 — 14 migration, tất cả đã áp dụng
tests/         25 file · 824 test
scripts/       seed-*.ts · demo · các luồng kiểm tra HTTP
```
