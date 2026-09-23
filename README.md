# AMIS Platform

Nền tảng ERP tự xây (Next.js + Drizzle + PostgreSQL), thiết kế để **nghiệp vụ thay đổi được qua giao diện mà không cần sửa code**.

---

## Vấn đề cần giải quyết

Luật thuế và BHXH Việt Nam đổi liên tục:

| Thay đổi | Văn bản | Hiệu lực |
|---|---|---|
| Giảm trừ gia cảnh 11tr/4,4tr → **15,5tr/6,2tr** | NQ 110/2025/UBTVQH15 | 01/01/2026 |
| Mức tham chiếu 2.340.000 → **2.530.000** | NĐ 161/2026/NĐ-CP | 01/07/2026 |
| Biểu thuế 7 bậc → **5 bậc** | Luật 109/2025/QH15 | 2026 (ngày còn tranh cãi) |
| Lương tối thiểu vùng | NĐ 293/2025/NĐ-CP | 01/07/2025 |

Nếu những con số này nằm trong hằng số TypeScript thì mỗi lần luật đổi phải **sửa code → build → test → deploy**. Với khách hàng on-premise còn phải nâng cấp từng máy.

## Giải pháp: tham số là DỮ LIỆU, không phải code

```
┌─────────────────────────────────────────────────────────────┐
│  GIAO DIỆN (người dùng sửa luật)                            │
│    form tự sinh từ JSON Schema trong policy_kinds           │
└──────────────────────┬──────────────────────────────────────┘
                       │ ghi
┌──────────────────────▼──────────────────────────────────────┐
│  PostgreSQL                                                 │
│    policy_kinds      — loại chính sách + JSON Schema        │
│    policy_versions   — tham số theo khoảng hiệu lực         │
│    policy_audit_logs — ai sửa gì, lúc nào, từ IP nào        │
└──────────────────────┬──────────────────────────────────────┘
                       │ đọc theo NGÀY của kỳ lương
┌──────────────────────▼──────────────────────────────────────┐
│  ENGINE  calculatePit(thuNhap, params)                      │
│          ▲ params TRUYỀN VÀO, không đọc hằng số             │
└─────────────────────────────────────────────────────────────┘
```

**Luật đổi = thêm một dòng vào `policy_versions`.** Không sửa code, không build, không deploy.

### Ranh giới: cái gì configurable, cái gì không

Đây là chỗ ERPNext/Odoo đi sai — họ làm *mọi thứ* thành metadata, kết quả là lỗi nằm trong DB không trace được, không test được. Nguyên tắc ở đây:

| Ổn định → code thật, type-safe | Hay đổi → config trong DB |
|---|---|
| Bất biến kế toán kép (Σ Nợ = Σ Có) | Biểu thuế, bậc, mức giảm trừ |
| Auth, RBAC, data scope | Tỷ lệ BHXH, mức tham chiếu, trần đóng |
| Ràng buộc toàn vẹn dữ liệu | Ngưỡng duyệt đơn từ |
| Giao thức thiết bị chấm công | Thành phần công thức lương |
| Cấu trúc bút toán GL | Mẫu in, định nghĩa báo cáo |

---

## Ba ràng buộc ép ở TẦNG DATABASE

Không tin application layer. Nếu service có bug, hoặc hai request ghi đồng thời, PostgreSQL vẫn từ chối.

### 1. `EXCLUDE` — chống chồng lấn khoảng hiệu lực

```sql
EXCLUDE USING gist (
  kind_code WITH =,
  daterange(effective_from, effective_to, '[)') WITH &&
) WHERE (status = 'ACTIVE')
```

**Nếu thiếu:** một ngày nào đó sẽ tồn tại hai mức thuế cùng áp dụng cho một ngày, engine chọn tuỳ ý, sai tiền thuế mà **không có lỗi nào được ném ra**. Đây là loại lỗi âm thầm nguy hiểm nhất trong hệ thống tiền bạc.

Khoảng dùng `[from, to)` nửa mở — bản kết thúc 30/06 và bản bắt đầu 01/07 **không** bị coi là chồng lấn.

### 2. `CHECK` — khoảng hiệu lực hợp lệ

`effective_to IS NULL OR effective_to > effective_from`

### 3. `CHECK` — bản ACTIVE phải có người duyệt

`status <> 'ACTIVE' OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)`

Không cho kích hoạt "chui" một bộ tham số thuế.

---

## Engine thuế: hai cách tính, luôn đối chiếu

Cơ quan thuế cho phép tính tắt bằng "số trừ nhanh". Nhưng cách tính từng phần và cách tính tắt **phải cho cùng kết quả**. Engine tính cả hai rồi so sánh:

```ts
const pit             = roundVnd(tax);                              // từng phần
const pitByQuickFormula = roundVnd(income * rate - quickDeduction); // tính tắt
quickFormulaMatch: Math.abs(pit - pitByQuickFormula) <= 1
```

Nếu lệch → bộ tham số trong DB bị nhập sai. Bắt ngay, không để lọt ra phiếu lương.

Zod schema cũng chặn từ lúc nhập: bậc thuế phải tăng dần, thuế suất phải luỹ tiến, **số trừ nhanh phải khớp công thức** (không cho gõ tay một con số tuỳ ý).

---

## Trạng thái hiện tại

### Đã xây

```
src/db/schema.ts          4 bảng: policy_kinds, policy_versions,
                              policy_audit_logs, pay_runs
src/db/extras.sql         EXCLUDE constraint (Drizzle không diễn đạt được)
src/policy/tax-params.ts  Zod schema + JSON Schema + 3 chế độ thuế seed
src/policy/registry.ts    ensureKind / createVersion / activateVersion /
                              resolvePolicy / getAuditTrail
src/engine/pit.ts         calculateProgressivePit, calculateTaxableIncome
drizzle/0000_init.sql     migration
scripts/demo-law-change.ts  demo đổi luật

src/components/schema-form.tsx   ★ THÀNH PHẦN THEN CHỐT: đọc JSON Schema
                                   trong policy_kinds.params_schema và TỰ SINH
                                   form + validateAgainstSchema
src/components/ui/index.tsx      primitives viết tay kiểu shadcn
src/app/page.tsx                 danh sách loại chính sách
src/app/policies/[kind]/page.tsx  dòng thời gian phiên bản + audit
src/app/policies/[kind]/new/page.tsx  form tạo bản mới
src/app/api/policies/**          GET/POST policies, versions, activate
tests/schema-form.spec.ts        chống lệch giữa JSON Schema và Zod schema

src/policy/si-params.ts     ★ LOẠI CHÍNH SÁCH THỨ HAI: VN_BHXH (Zod + JSON Schema)
src/engine/si.ts            calculateSocialInsurance — trần BHXH theo mức tham
                            chiếu, trần BHTN theo lương tối thiểu vùng
src/engine/money.ts         roundVnd + clampBase (dùng chung cho cả hai engine)
scripts/seed-bhxh.ts        seed VN_BHXH, idempotent
tests/si.spec.ts            20 test cho engine + ràng buộc pháp lý BHXH
tests/helpers.ts            expectSchemasAgree — so JSON Schema với Zod

src/engine/formula.ts       ★ port NGUYÊN KHỐI từ Phase 1: tokenizer → parser
                              → AST → evaluator. Không eval, không Function.
src/policy/salary-params.ts ★ LOẠI THỨ BA: công thức lương là DỮ LIỆU
src/engine/salary.ts        calculateSalary — chạy công thức theo sequence
scripts/seed-salary.ts      seed + demo chạy xuyên cả ba engine
tests/formula.spec.ts       30 test port theo (phần PIT của Phase 1 bỏ, đã có
                            policy.spec.ts viết lại cho engine mới)
tests/salary.spec.ts        27 test cho công thức lương

src/policy/approval-params.ts ★ LOẠI THỨ TƯ: ngưỡng duyệt
src/engine/approval.ts        resolveApprovalChain — trả về CHUỖI người duyệt
scripts/seed-approval.ts      seed + demo chuỗi duyệt
tests/approval.spec.ts        21 test cho ngưỡng duyệt

src/policy/print-params.ts  ★ LOẠI THỨ NĂM: mẫu in (HTML + CSS là dữ liệu)
src/engine/print.ts         renderTemplate / escapeHtml / soThanhChu / renderDocument
src/lib/payslip.ts          nối 3 engine → dữ liệu phiếu lương
src/app/print/page.tsx      danh sách mẫu in
src/app/print/[code]/route.ts  trả về MỘT tài liệu HTML in được
scripts/seed-print.ts       seed mẫu phiếu lương
tests/print.spec.ts         59 test: XSS, template, số thành chữ, định dạng

src/db/schema.ts            ★ employees + payslips (Phase 6)
src/lib/payroll.ts          tính cả kỳ trong MỘT transaction
src/app/payroll/…           bảng lương + chi tiết kỳ
scripts/run-payroll.ts      seed 12 nhân viên + tính kỳ 09/2026
tests/payroll.spec.ts       15 test: ngày công chuẩn, chặn đầu vào sai
vitest.config.ts            alias @/ — thiếu file này thì test không import được

src/policy/report-params.ts ★ LOẠI THỨ SÁU: định nghĩa báo cáo (JSON, không SQL)
src/engine/report.ts        ghép SQL từ whitelist, mọi giá trị qua $1, $2…
src/app/reports/…           danh sách + chạy báo cáo + xem câu SQL đã sinh
src/app/api/reports/[code]/ JSON hoặc CSV (có BOM cho Excel)
scripts/seed-report.ts      seed 2 báo cáo
tests/report.spec.ts        32 test: tiêm SQL, HAVING, ép kiểu, CSV

src/engine/workflow.ts      ★ MÁY TRẠNG THÁI DUYỆT (port từ Phase 1, đã sửa 1 lỗ hổng)
src/lib/approval.ts         nối ngưỡng (dữ liệu) với trạng thái (code)
src/lib/uuid.ts             chặn id rác trước khi chạm PostgreSQL
src/app/approvals/…         danh sách đơn, chuỗi duyệt, nút hành động, dấu vết
src/app/api/approvals/[id]/ thực hiện một hành động duyệt
scripts/approval-flow.ts    chạy thử end-to-end + kiểm tra trigger bất biến
tests/workflow.spec.ts      52 test: state machine, điều kiện, audit, IP

src/engine/auth.ts          ★ bcrypt salt 10, JWT (jose), băm refresh token
src/lib/auth.ts             login, xoay vòng token, RBAC, rate limit trong DB
src/middleware.ts           security headers (thay helmet) + CORS whitelist
src/app/api/auth/…          login / refresh / logout, refresh trong cookie HttpOnly
scripts/seed-auth.ts        20 quyền, 5 vai trò, 6 người dùng
scripts/auth-flow.ts        32 kiểm tra end-to-end
tests/auth.spec.ts          32 test: các đường tấn công JWT, bcrypt, so sánh thời gian

src/policy/bank-params.ts   ★ tham số 4 ngân hàng — policy kind thứ MƯỜI MỘT
src/engine/payment-file.ts  ★ sinh + kiểm file UNC: VCB định dạng cố định, CSV chung
src/lib/payment.ts          xuất lô, đối chiếu SHA-256, máy trạng thái
src/app/api/payment-batches/…  tải file (kèm kiểm băm) + đổi trạng thái
src/app/payments/page.tsx   danh sách lô toàn hệ thống
scripts/seed-payment.ts     4 cấu hình ngân hàng + 11 tài khoản + xuất một lô
scripts/payment-flow.ts     17 kiểm tra QUA HTTP THẬT (route chưa từng chạy nếu không)
tests/payment.spec.ts       33 test: định dạng file, bỏ dấu, đối chiếu tổng
tests/payment-service.spec.ts  17 test: ràng buộc DB, máy trạng thái, PostgreSQL thật

src/engine/geofence.ts      ★ Haversine, point-in-polygon, đối soát BSSID
src/engine/liveness.ts      ★ FFT 2D thật, phổ Moiré, Laplacian, điểm liveness
src/policy/geofence-params.ts   loại thứ 12: tâm+bán kính HOẶC polygon, BSSID
src/policy/liveness-params.ts   loại thứ 13: ngưỡng chống ảnh in / phát lại
src/lib/location.ts         adapter tham số phẳng → đầu vào engine (một chỗ duy nhất)
src/lib/location-check.ts   kiểm tra quẹt theo hàng rào, ghi ngược geo_status
src/app/api/attendance/check-locations/route.ts
src/components/location-check.tsx
scripts/seed-geofence.ts    2 địa điểm (trụ sở Q1, nhà máy VSIP) + 1 bộ ngưỡng
scripts/check-locations.ts  npm run check:locations — phân bố theo trạng thái
tests/geofence-liveness.spec.ts  42 test, port từ Phase 1 + 3 test cho bug tìm thấy
tests/geo-params.spec.ts    20 test ràng buộc tham số + adapter
tests/location-check.spec.ts   12 test trên PostgreSQL thật, transaction rollback

src/engine/adms.ts          ★ parser ADMS/Push SDK: ATTLOG 7 cột, lệnh trả về máy
src/engine/hikvision.ts     ★ parser ISAPI: JSON + XML + multipart, Digest RFC 2617
src/lib/device-ingest.ts    xác thực máy, ánh xạ số thẻ → nhân sự, khử trùng lặp
src/app/api/devices/adms/route.ts        webhook Ronald Jack / ZKTeco
src/app/api/devices/hikvision/route.ts   webhook Hikvision FaceID
tests/device-protocol.spec.ts   83 test parser (port từ Phase 1 + 7 test cho lỗi sửa)
tests/device-ingest.spec.ts     14 test trên PostgreSQL thật

Dockerfile                  ★ 3 tầng: deps → builder → runner (standalone)
docker-compose.yml          db + migrate (one-shot) + app
docker/migrate.sh           chờ DB → migrate → EXCLUDE → seed (theo cờ)
docs/deployment.md          triển khai, sao lưu, nâng cấp, và những gì CHƯA kiểm chứng
scripts/seed-tax.ts         VN_PIT — trước đây chỉ có trong script demo
scripts/seed-employees.ts   12 nhân viên, tách khỏi payroll để phá vòng phụ thuộc
scripts/roster.ts           danh sách nhân viên dùng chung cho hai script
src/app/api/health/…        /api/health — CÓ ping DB, không chỉ "Next sống chưa"
```

### Đã kiểm chứng

**Trên PostgreSQL 18.4 thật — không mock.** Lý do: ba ràng buộc quan trọng nhất nằm ở tầng DB, mà mock không thực thi chúng. Test trên mock sẽ xanh trong khi hệ thống thật vẫn cho phép hai mức thuế chồng lấn.

```
npm run verify
  ✓ tsc --noEmit        0 lỗi
  ✓ drizzle-kit migrate áp dụng từ DB trắng
  ✓ db:extras           EXCLUDE constraint
  ✓ vitest              586/586 test (18 file)
```

Test đáng chú ý:

- Ghi **SQL thô** cố tình vi phạm → DB từ chối (chứng minh ràng buộc ở DB, không phải ở code)
- Engine `calculatePit(NaN, …)` → **ném lỗi**, không trả 0đ âm thầm
- Quét 1M → 200M: biểu 5 bậc luôn ≤ biểu 7 bậc (nếu có mức nào ngược lại thì một bộ tham số bị nhập sai)
- `resolvePolicy` vào khoảng trống → **ném lỗi rõ ràng**, không dùng giá trị mặc định
- **JSON Schema và Zod schema phải cùng tập trường** — bắt được bug thật, xem ghi chú thiết kế bên dưới
- Giá trị do `defaultsFromSchema` sinh ra **không được phép lưu** (form không cho lưu bộ tham số rỗng)
- **TK 334 về 0** sau ba bút toán — phép thử bắt được cả "ghi thiếu" lẫn "ghi trùng"
- Chi tiết bảo hiểm lệch tổng đã lưu **một đồng** → ném lỗi, không ghi sổ
- Kỳ lương không ai bị khấu trừ → **bỏ qua** bút toán khấu trừ, không tạo bút toán rỗng
- Số hiệu bút toán trùng → ràng buộc `UNIQUE` ở PostgreSQL, giao dịch roll back
- `AccessError` phân tách **401 và 403** — gộp lại thì client không biết nên đăng nhập lại hay đừng thử nữa
- `authErrorResponse` **ném lại** lỗi lạ thay vì nuốt thành 401 — DB chết phải hiện ra là 500
- `safeRedirectTarget` chặn `//evil.com`, `/\\evil.com`, `javascript:` — những cái **qua được** kiểm tra `startsWith('/')`
- Ca đêm 22:00→06:00 có `endDate` là **ngày hôm sau**, kể cả khi vắt qua tháng, qua năm, qua 29/02 năm nhuận
- **Bất biến 3 ca 4 kíp**: quét 40 ngày liên tiếp, mỗi ngày đúng một kíp/ca và một kíp nghỉ — không ca trùng, không hở
- Ca 12 tiếng 20:00→08:00 chỉ tính **480** phút đêm, không phải 960 — bắt lỗi đếm trùng khoảng đêm
- Hai đoạn **chạm** nhau (12:00 ra, 12:00 vào) thì hợp lệ; **đè** nhau thì bị từ chối
- Làm 08:00–11:00 → đúng **180** phút công, không bị trừ giờ nghỉ trưa mà họ không nghỉ
- Hai quẹt 08:00 và 11:00 → 11:00 là giờ RA, không phải "quẹt vào lần hai"
- Ngày nghỉ không đi làm → `WEEKLY_OFF`, **không phải** `ABSENT`; đi làm thì công chính = 0, toàn bộ là OT
- Quẹt 03:00 không thuộc ca 08:00 → bị loại khỏi cửa sổ ghép cặp
- Xuất lô **lần hai** cho cùng (kỳ, ngân hàng) → PostgreSQL ném `23505` trên `uq_bank_batches_one_active`. Đây là ràng buộc ngăn một cú đúp chuột trả lương hai lần
- `VOID` là trạng thái **cuối**: phục hồi một lô đã huỷ là biến một file chưa từng gửi thành "đã gửi"
- Hai tài khoản cùng `is_primary = true` cho một người → DB chặn; hai tài khoản không chính thì được
- Nhân viên thiếu tài khoản **không bị bỏ qua im lặng** — bị loại khỏi file và nêu trong `missing[]` kèm số tiền chưa trả
- Bỏ dấu tiếng Việt **giữ lại `/ - .`** — bản đầu tiên xoá mọi ký hiệu nên `LUONG T09/2026 NV001` ra thành `LUONG T092026 NV001`. Ngân hàng vẫn nhận, nhưng đó là dòng người lao động dùng để nhận ra lương của mình trên sao kê
- Tổng ở footer được đối chiếu với tổng các dòng **trước khi ghi**; lệch một đồng là không sinh file
- `npm run payroll` trên một kỳ **không có chấm công** → **từ chối chạy**, exit 1. Bản trước chỉ in một dòng cảnh báo rồi trả đủ 26 ngày công và exit 0 — một chuỗi seed sai thứ tự vì thế không ai phát hiện: số vẫn đẹp, chỉ là sai
- Dựng một **PostgreSQL trắng** bằng đúng `docker/migrate.sh` cho ra DB giống hệt DB phát triển: 25 bảng, 11 migration, 2 EXCLUDE, tổng chi phí kỳ lương **522.915.846 đ**, lô thanh toán **407.724.352 đ** — khớp từng đồng
- `employeesWithoutAccount` chỉ nêu người **còn làm việc** — bản đầu tiên liệt cả người đã nghỉ, và một danh sách dài toàn nhiễu thì không ai đọc

### Chạy thử

```bash
cp .env.example .env        # điền DATABASE_URL
npm install
npm run db:setup            # migrate + EXCLUDE constraint
npm run test                # 58 test
npm run demo                # demo đổi luật thuế
npm run seed:bhxh           # seed loại chính sách VN_BHXH
npm run seed:salary         # seed công thức lương + demo cả ba engine
npm run seed:approval       # seed ngưỡng duyệt
npm run seed:print          # seed mẫu in
npm run seed:report         # seed 2 báo cáo (cần chạy payroll trước)
npm run seed:gl             # danh mục tài khoản + định khoản lương
npm run seed:shift          # 5 định nghĩa ca: hành chính, ca gãy, CA1/CA2/CA3
npm run seed:attendance     # thiết bị, 11 ngày lễ 2026, hệ xoay, lịch 30 ngày,
                            # 762 quẹt thẻ — rồi tính công và in đối chiếu
npm run demo:gl             # ghi sổ kỳ 09/2026, in bút toán + bảng đối chiếu
npm run demo:rbac           # 17 kiểm tra phân quyền + phân tách nhiệm vụ
cp .env.docker.example .env # rồi ĐỔI MẬT KHẨU
docker compose up -d --build  # db + migrate + app; xem docs/deployment.md
npm run seed:tax            # biểu thuế TNCN — 3 chế độ theo thời gian
npm run seed:employees      # 12 nhân viên (phải chạy TRƯỚC seed:attendance)
npm run seed:geofence       # 2 địa điểm + 1 bộ ngưỡng liveness (không cần dữ liệu)
npm run check:locations     # kiểm tra vị trí 411 quẹt di động, in phân bố
npm run seed:payment        # 4 cấu hình ngân hàng + tài khoản NV + xuất một lô
npm run demo:payment        # 17 kiểm tra qua HTTP thật (cần dev server ở 3100)
npm run seed:all            # cả mười một loại chính sách
npm run payroll             # seed 12 nhân viên + tính kỳ 09/2026
npm run demo:approval       # chạy thử quy trình duyệt end-to-end
npm run seed:auth           # 14 quyền, 5 vai trò, 6 người dùng
npm run demo:auth           # 32 kiểm tra luồng xác thực + RBAC
npm run dev                 # giao diện tại http://localhost:3100
```

Demo: cùng một nhân viên (gross 45tr, 1 phụ thuộc), bốn kỳ lương:

| Kỳ | Chế độ | Giảm trừ bản thân | Thuế TNCN |
|---|---|---|---|
| 2025-09 | LEGACY_7B | 11.000.000 | **3.179.000** |
| 2026-03 | BRIDGE_2026H1 | 15.500.000 | **1.926.750** |
| 2026-09 | VN_2026_5B | 15.500.000 | **1.284.500** |
| 2027-03 | VN_2027_DEMO *(tạo trong demo)* | 20.000.000 | **834.500** |

Bản 2027 được **tạo và kích hoạt ngay trong script** — không sửa một dòng code nào.

---

## Lộ trình

| Phase | Nội dung | Trạng thái |
|---|---|---|
| **1** | Policy Registry + engine thuế | ✅ xong, đã kiểm chứng |
| **2** | Next.js UI: trang quản lý chính sách, form tự sinh từ JSON Schema | ✅ xong, đã kiểm chứng |
| **3** | Mở rộng loại chính sách: ~~BHXH~~ ✅ · ~~công thức lương~~ ✅ · ~~ngưỡng duyệt~~ ✅ | ✅ xong, đã kiểm chứng |
| **4** | ~~Workflow designer~~ ✅ máy trạng thái + chuỗi duyệt chụp lúc nộp + audit trail bất biến bằng trigger + UI | ✅ |
| **5** | Print format ✅ · report builder ✅ (định nghĩa JSON, engine ghép SQL từ whitelist) | ✅ |
| **6** | Employee + PayRun thật: bảng `employees`, `payslips`, tính cả kỳ trong một transaction, in phiếu từ số liệu đã lưu | ✅ |
| **7** | JWT + refresh HttpOnly có xoay vòng, bcrypt salt 10, RBAC 2 tầng (quyền + phạm vi dữ liệu), rate limit trong DB, security headers | ✅ |
| **8** | ~~Cầu nối HR → sổ cái~~ ✅ ba bút toán kép cho một kỳ lương, định khoản là tham số, cân đối ép ở **hai** tầng, chống ghi trùng bằng khoá duy nhất | ✅ |
| **9** | ~~Nối RBAC vào route~~ ✅ `requirePermission`, quyền tra từ DB không từ token, phân tách nhiệm vụ HR ≠ kế toán, `/login` + đổi mật khẩu bắt buộc, chặn open redirect | ✅ |
| **10** | ~~Engine ca kíp~~ ✅ ca hành chính / ca gãy / **ca đêm vắt 0h** / xoay 3 ca 4 kíp, khung giờ đêm là tham số, định nghĩa ca là policy kind thứ tám | ✅ |
| **11** | ~~Ghép cặp quẹt thẻ~~ ✅ FIRST-IN/LAST-OUT theo đoạn, suy giờ khi thiếu quẹt nhưng đánh dấu `MISSING_PUNCH`, OT tách 150/200/300% + phần đêm, grace period và mọi ngưỡng là tham số | ✅ |
| **12** | ~~Chấm công ngày~~ ✅ 5 bảng (`shift_devices` / `raw_punches` chỉ-thêm / `employee_shifts` / `public_holidays` / `daily_attendance` dẫn xuất), hệ xoay là policy kind thứ mười, API + trang `/attendance`, seed 762 quẹt · 360 ngày công | ✅ |
| **13** | ~~Nối chấm công vào lương~~ ✅ bỏ map fixture hardcode trong `run-payroll`, đọc `daily_attendance`; thêm phụ cấp đêm 30% + OT đêm 200/210/270/390%; trang kỳ lương hiện **công thức đã chạy** cho từng thành phần | ✅ |
| **15** | ~~Docker + triển khai~~ ✅ Dockerfile 3 tầng (standalone), compose `db`/`migrate`/`app`, `/api/health` có ping DB, `docs/deployment.md`. Dọn DB trắng lộ ra **3 lỗi seed thật** — xem ghi chú thiết kế | ✅ |
| **14** | ~~File thanh toán ngân hàng~~ ✅ `employee_bank_accounts` + `bank_payment_batches`, định dạng VCB/TCB/CTG/MBB là **tham số** (kind thứ 11), nội dung file lưu kèm SHA-256 và server từ chối trả nếu băm lệch, một kỳ một lô ép bằng unique index riêng phần, trang `/payments` | ✅ |
| **18** | ~~Bảo vệ các trang RSC~~ ✅ xem chi tiết ở ghi chú dưới bảng | ✅ |
| **19** | ~~Khoá các API route bị bỏ quên~~ ✅ **Nghiêm trọng hơn cả Phase 18.** 6/23 API route KHÔNG có bất kỳ kiểm tra quyền nào. Kiểm chứng bằng `curl` không kèm gì: `GET /api/policies` → **200, 33.413 byte**; `GET /api/reports/LUONG_THEO_BO_PHAN?format=csv` → **200, CSV lương đầy đủ**; `POST /api/policies/VN_PIT/versions {}` → **400 INVALID_PARAMS**; `POST …/activate` → **400 VERSION_NOT_FOUND**; `POST /api/approvals/<uuid> {}` → **400 UNKNOWN_ACTION**. Ba mã 400 là bằng chứng: nếu quyền được kiểm tra trước thì phải là 401 — nghĩa là request đã đi xuyên qua tầng xác thực vào tới Zod và state machine, tức người ẩn danh sửa được biểu thuế, kích hoạt nó và duyệt lương. Kèm 4 nút "tải" dùng `<a href>` nên nhận về 401. Nay: `requirePermission` ở cả 6 route + `AuthDownload` cho 4 nút tải + 42 test whitelist-ngược | ✅ | **Lỗ hổng nghiêm trọng:** mọi trang render phía server đọc DB và trả dữ liệu thật mà KHÔNG kiểm tra phiên — `curl /payroll` không cần đăng nhập vẫn ra tổng lương. Nguyên nhân: API đòi header `Authorization` còn trang chỉ nhìn thấy cookie, mà `refresh_token` cố ý đặt `Path=/api/auth` nên không tới được trang. Nay có cookie phiên `access_token` (`Path=/`, 15 phút) + `requirePageSession()` ở 12 trang + cổng chặn ở middleware. Kèm 21 test chống tái phạm | ✅ |
| **17** | ~~Parser giao thức thiết bị~~ ✅ ADMS/Push SDK (Ronald Jack, ZKTeco) + Hikvision ISAPI (JSON/XML/multipart, Digest RFC 2617). Hai webhook thật, xác thực bằng khoá mỗi máy, khử trùng lặp bằng ràng buộc DB. **Sửa 5 lỗi khi port** — xem ghi chú thiết kế | ✅ |
| **16** | ~~Geofence + chống giả mạo khuôn mặt~~ ✅ port từ Phase 1 thành policy kind thứ **12** (GEOFENCE) và thứ **13** (LIVENESS). Haversine + point-in-polygon + đối soát BSSID; FFT 2D thật để bắt vân Moiré của màn hình, Laplacian để bắt ảnh in. Kết luận ghi vào `raw_punches` tại thời điểm kiểm tra. **Tìm thấy và sửa một bug 41%** khi port | ✅ |

---

## Ghi chú thiết kế

**Mã lỗi 400 ở một endpoint "có xác thực" là bằng chứng nó KHÔNG xác thực.** Đây là cách tìm ra lỗ hổng Phase 19: gửi payload rác `{}` không kèm token. Nếu quyền được kiểm tra trước thì nhận 401; nhận 400 nghĩa là request đã đi qua tầng xác thực vào tới kiểm tra tham số. Ba endpoint trả 400 — tức là chỉ cần gửi payload ĐÚNG là người ẩn danh ghi được vào hệ thống lương. Quy tắc rút ra: khi nghi ngờ một endpoint, đừng gửi payload đúng (sẽ sửa dữ liệu thật), hãy gửi payload rác và đọc MÃ LỖI.

**Route công khai phải là WHITELIST NGƯỢC.** `tests/api-auth.spec.ts` mặc định đòi mọi route có `requirePermission`; route nào muốn mở phải nằm trong `PUBLIC_ROUTES` kèm LÝ DO viết ra thành chữ. Nếu mặc định là "không cần kiểm tra" thì quên một dòng là một lỗ hổng im lặng; mặc định ngược lại thì quên một dòng là một test đỏ. Cùng một sơ suất, hai hậu quả rất khác nhau.

**Hai đường vào dữ liệu thì phải canh cả hai — và test phải đi qua đường ít được nghĩ tới.** Lỗ hổng trang RSC sống qua 18 phase mà không test nào bắt được, vì **mọi test đều gọi API**, và API thì có `requirePermission` đầy đủ. Trang RSC là một đường vào hoàn toàn khác: nó chạy trên server, đọc thẳng DB, và chỉ nhìn thấy cookie. Một bộ test chỉ đi qua đường được canh thì xanh mãi trong khi đường kia hở. Bài học rút ra không phải "thêm test cho trang" mà là **liệt kê các đường vào dữ liệu trước, rồi mới viết test**.

**Vì sao phải thêm cookie THỨ HAI chứ không nới path của `refresh_token`.** `refresh_token` đặt `Path=/api/auth` là cố ý: thu hẹp phạm vi nó bị gửi đi, giảm rò rỉ. Nới thành `Path=/` thì token sống 14 ngày đi kèm mọi request, kể cả request tới máy chủ tĩnh hay log của proxy. Nên giữ nguyên token dài hạn ở path hẹp, và cho access token — vốn chỉ sống 15 phút và là JWT ký bằng secret của server — đi thêm một cookie `Path=/`. Phạm vi phơi bày ngắn, và không thể tự tạo.

**Một object chỉ giữ được MỘT giá trị cho cùng một tên header.** `{ headers: { 'Set-Cookie': a } }` rồi thêm `Set-Cookie: b` là cookie thứ hai **âm thầm ghi đè** cookie thứ nhất. Không có lỗi nào kêu lên; chỉ thấy "đăng nhập xong vào trang vẫn bị đẩy về /login". Phải dùng `Headers.append`.

**Xoá cookie sai `Path` thì không xoá được gì.** `clearSessionCookie()` phải mang đúng `Path=/` như lúc tạo. Nếu xoá với path khác, trình duyệt giữ nguyên cookie cũ: người dùng bấm "Đăng xuất", F5 một cái vẫn vào được trang — và tin rằng mình đã đăng xuất trên máy công cộng.

**Một thẻ `<a href>` không bao giờ tải được file từ endpoint có xác thực.** Thẻ `<a>` chỉ gửi cookie, còn endpoint đòi header `Authorization`, nên bấm vào là nhận trang JSON 401 — trong khi nút vẫn trông hoàn toàn bình thường. Lỗi này ĐÃ được ghi chú trong `payment-export.tsx` nhưng vẫn còn ở 4 chỗ khác: cùng một việc được làm theo hai cách, và chỉ một cách đúng. Cách sửa không phải cho endpoint nhận cookie (file lương là thứ nhạy cảm nhất, cho tải bằng cookie là mở CSRF đúng chỗ tệ nhất) mà là client đính kèm token rồi tải qua blob.

**Một assertion cũ nằm ở HAI chỗ thì sẽ hỏng ở cả hai mà không ai thấy.** `EMPLOYEE chỉ có print:read` (`permissions.size === 1`) được viết ở Phase 9; Phase 14 thêm `attendance:read` cho EMPLOYEE với lý do chính đáng nhưng không cập nhật assertion — và assertion đó được chép ở cả `auth-flow.ts` lẫn `rbac-flow.ts`. Nó đỏ âm thầm từ Phase 14 vì `npm run verify` không chạy demo script. Nay so **đúng tập quyền** thay vì so số lượng: `size === 1` vẫn pass nếu ai đó đổi một quyền này lấy một quyền khác hoàn toàn.

**Lệnh `SET_TIME` gửi giờ UTC cho cái máy đang chờ giờ địa phương.** Bản Phase 1 viết `new Date().toISOString().slice(0,19)` bên trong `buildAdmsResponse`. Hai hậu quả cùng lúc: hàm không kiểm thử được (không khẳng định được nội dung lệnh), và `toISOString()` là **giờ UTC** trong khi máy chờ giờ địa phương — với máy ở Việt Nam thì mỗi lần đồng bộ, đồng hồ bị đặt **lùi 7 tiếng**. Kiểm chứng bằng cách cho máy "nhận" lệnh rồi parse lại: bản cũ ra 01:30 giờ VN trong khi thực tế là 08:30. Máy vẫn chấm công được, chỉ sai giờ, nên lỗi này sống rất lâu — và mọi ca đêm bị tính sang ngày hôm trước. Nay `now` và `tzOffsetHours` là tham số.

**Webhook thiết bị phải trả 400 chứ không phải 500 cho một body hỏng.** Máy chấm công retry khi nhận 5xx. Nghĩa là một firmware gửi thiếu trường `dateTime` sẽ khiến máy bắn lại sự kiện đó **mãi mãi**, log đầy 500, và không quẹt nào được ghi. Trớ trêu là chính comment trong `extractAlertFromText` của Phase 1 đã cảnh báo điều này — nhưng `parseHikvisionEvent` lại để `parseIsoWithOffset` ném thẳng ra ngoài, tức là đúng cái trường hợp nó vừa nêu. Test cũ còn khoá chặt hành vi đó (`expect(...).toThrow(/dateTime/)`), nên đã phải viết lại test chứ không chỉ sửa code.

**`Number(x) || 0` là cách nhanh nhất để biến dữ liệu hỏng thành một kết luận sai có vẻ hợp lệ.** Parser ATTLOG của Phase 1 đọc mọi cột số bằng công thức đó. Với cột `workCode` thì 0 nghĩa là **PASSWORD** — một firmware gửi rác vì thế không gây lỗi nào cả, nó chỉ âm thầm ghi nhận mọi quẹt thẻ thành quẹt mật khẩu. Nay cột rỗng (hợp lệ — máy thật sự gửi rỗng khi không dùng `jobCode`) khác cột rác (bị đẩy sang `skipped`).

**Thiết bị không giữ được JWT, nhưng endpoint cũng không được mở toang.** Máy chấm công chỉ biết gửi HTTP POST. Nếu webhook không xác thực thì bất kỳ ai biết URL cũng bơm được quẹt giả cho cả công ty — và đó là cách nhanh nhất để phá bảng lương mà không cần đụng vào mã nguồn. Nên mỗi máy một khoá chia sẻ, so bằng `timingSafeEqual` (so `===` dừng ở byte khác biệt đầu tiên nên thời gian trả lời tiết lộ độ dài phần đúng). Và ba lý do từ chối là **ba mã khác nhau** — máy chưa đăng ký / khoá sai / máy đã ngừng dùng — vì đó là ba việc khác nhau người vận hành phải làm.

**Khử trùng lặp bằng ràng buộc DB, không bằng "đọc xem có chưa rồi mới ghi".** Máy ADMS gửi lại toàn bộ log mỗi lần mất mạng, và hai lần gửi có thể đến gần như đồng thời. Cách đọc-rồi-ghi có cửa race: cả hai cùng đọc được "chưa có", rồi cả hai cùng ghi. `uq_raw_punches_once` trên (nhân viên, máy, thời điểm) thì không có cửa nào — lần thứ hai nhận `onConflictDoNothing` và được đếm vào `duplicates`.

**Số thẻ trên máy và mã nhân sự là HAI con số.** Cột `employees.device_user_id` tách khỏi `employee_code` và có **unique index từng phần** (`WHERE device_user_id IS NOT NULL`) — nếu để unique thường thì hai nhân viên văn phòng cùng để trống sẽ xung đột ngay ở dòng thứ hai, trong khi "không dùng máy chấm công" là trạng thái hợp lệ của đa số họ. Số thẻ không khớp ai thì được **nêu lên** trong response chứ không bỏ qua im lặng: một máy vừa nạp lại vân tay với dãy PIN mới sẽ sinh ra hàng trăm quẹt "không biết của ai", và đó là việc phải thấy ngay, không phải ba tuần sau khi bảng lương thiếu người.

**Vì sao kết luận geofence được LƯU chứ không tính lại mỗi lần xem.** Hàng rào là chính sách **có khoảng hiệu lực**. Nếu kết luận được tính lúc hiển thị thì ba tháng sau, một quẹt thẻ cũ sẽ bị đánh giá theo hàng rào MỚI — và kết luận hôm nay khác kết luận đã dùng để quyết định ngày hôm đó. Cùng một quẹt, hai bản án, và không ai biết bản nào đã được dùng. Nên `geo_status` ghi vào `raw_punches` tại thời điểm kiểm tra, cùng nguyên tắc với `policySnapshot` của phiếu lương. Điều đó cũng có nghĩa là một quẹt có thể mang kết luận theo hàng rào đã hết hiệu lực — đó là **đúng**, không phải bug.

**Bốn trạng thái "có vấn đề" phải tách thành bốn, không phải một.** `REJECTED` (đứng sai chỗ / mock GPS / GPS quá mờ), `REVIEW` (trong bán kính cứng nhưng ngoài vùng tin cậy — vẫn được chấm công), `NO_FENCE` (địa điểm chưa được vẽ hàng rào — **lỗi của người quản trị**), `NO_GPS` (app không lấy được toạ độ — lỗi kỹ thuật, và iOS đổi quyền là cả công ty bị). Gộp bốn cái thành một con số "36 quẹt đáng ngờ" thì một lần quên vẽ hàng rào sẽ hiện ra thành hàng trăm vụ gian lận, và sau lần thứ hai không ai đọc danh sách đó nữa.

**Vì sao chỉ thiết bị di động bị kiểm tra vị trí.** `shift_devices.device_type` phân biệt `MOBILE` và `TERMINAL`. Máy chấm công được bắt vít vào tường, vị trí của nó là hiển nhiên, và nó **không gửi toạ độ**. Áp geofence cho nó thì 342 quẹt hợp lệ thành 342 dòng "không có GPS" — tức là biến một hệ thống đang chạy đúng thành một danh sách cảnh báo dài vô nghĩa, đúng cái bẫy đã gặp với `needsReview` ở Phase 12.

**Tổng sáu trọng số liveness phải đúng bằng 1, và ràng buộc đó nằm trong schema.** Điểm tổng hợp là tổng có trọng số, được so với `minConfidence` trong khoảng 0..1. Nếu trọng số cộng lại thành 0,7 thì điểm tối đa đạt được là 0,7 — đặt ngưỡng 0,8 là **không ai qua được**, kể cả người thật đứng trước camera. Ngược lại tổng 1,3 thì ảnh in ra giấy cũng có thể đạt 0,8. Cả hai hướng đều sai, cả hai đều không có thông báo nào kêu lên, và cả hai trông giống hệt "camera hôm nay chập chờn".

**Khi port code cũ, hãy tìm chỗ cùng một quy tắc được phát biểu HAI lần.** `pointInPolygon` và `distanceToPolygonEdgeM` của Phase 1 đều phải xử lý "polygon đóng hay mở", và chúng hiểu khác nhau: hàm thứ nhất chỉ bỏ điểm cuối khi nó **thật sự** trùng điểm đầu, hàm thứ hai bỏ điểm cuối chỉ vì `polygon.length > 3`. Với một tứ giác khai báo mở, hàm thứ hai mất hẳn một cạnh và thay bằng đường chéo — khoảng cách tới biên ra **78.709 m thay vì 55.660 m, lệch 41%**. Hai chỗ cùng phát biểu một quy tắc là hai chỗ sẽ lệch nhau; nay cả hai gọi chung một hàm `openRing`, và có test khoá con số đó lại.

**Một kỳ lương đã gửi ngân hàng thì không được tính lại — và lỗi RESTRICT nói lên điều đó.** `npm run payroll` trước đây mở đầu bằng `DELETE FROM pay_runs`, chạy tốt cho đến khi `bank_payment_batches` ra đời và trỏ vào nó bằng `ON DELETE RESTRICT`. Cách sửa không phải là xoá luôn uỷ nhiệm chi cho tiện: một lô ở trạng thái `SENT` là chứng từ **đã gửi ngân hàng**, xoá nó để chạy lại demo là xoá bằng chứng đối soát. Nay script phân biệt — lô `DRAFT`/`VOID` (chưa gửi, đã lỗi thời) thì xoá kèm cảnh báo, lô `SENT`/`RETURNED` thì **từ chối và thoát 1**, trừ khi người chạy tự bật `ALLOW_REPAID_PERIOD=true`.

**Vì sao cân đối bút toán bị ép ở hai tầng.** `assertBalanced` trong engine ném lỗi trước khi bút toán rời khỏi hàm, và PostgreSQL còn một ràng buộc `CHECK (total_debit = total_credit)` trên bảng `gl_entries`. Nghe thừa, nhưng hai tầng này bắt hai loại lỗi khác nhau: engine bắt lỗi do **logic sinh bút toán** sai, còn ràng buộc DB bắt mọi đường ghi khác — một script chạy tay, một lần migrate dở, một endpoint sau này ai đó thêm vào mà quên gọi engine. Kiểm chứng bằng cách ghi SQL thô cố tình lệch: DB trả `23514`. Chỉ tin vào kiểm tra ở tầng ứng dụng nghĩa là tin rằng mọi đường vào dữ liệu đều đi qua đúng một hàm, và đó là giả định không giữ được lâu.

**Bất biến mạnh nhất của kế toán lương: TK 334 về 0.** Sau ba bút toán — ghi nhận chi phí (Có 334 = gross), trích khấu trừ (Nợ 334 = bảo hiểm NLĐ + thuế + tạm ứng), trả lương (Nợ 334 = net) — số dư 334 phải đúng bằng 0. Nếu còn dư thì hoặc ghi thiếu hoặc ghi trùng, và phép thử này bắt được **cả hai** mà không cần biết trước con số đúng là bao nhiêu. Đây là lý do chọn nó làm kiểm tra chính thay vì so từng số dư với giá trị mong đợi: một phép so khớp số học nội tại không thể sai vì fixture sai.

**Số dư đọc theo bên bình thường, và cột đặt theo dấu thật.** TK 334 dư Có 500 triệu là hoàn toàn bình thường; hiển thị nó thành "−500 triệu" bắt kế toán tự đảo dấu trong đầu cho từng dòng. Nên `balance` được tính theo `normalSide`. Nhưng **cột** SD Nợ / SD Có thì phải đặt theo dấu thật của (nợ − có), không theo `normalSide`: TK 1121 sau khi chi tiền mang số dư **Có**, và bản đầu tiên tôi đặt cột theo bên bình thường nên in ra "SD Nợ 470.373.671" — bảng vẫn thẳng hàng, tổng vẫn cân, nhưng ngược dấu. Loại lỗi này không có gì tự nó kêu lên.

**Vì sao kỳ lương không có khấu trừ thì bỏ qua bút toán, chứ không báo lỗi.** Phải phân biệt hai trường hợp trông giống nhau: **0 dòng** nghĩa là nghiệp vụ không phát sinh (không ai bị trừ gì) — sinh ra bút toán rỗng còn tệ hơn không có gì, vì nó nằm trong sổ như thể đã hạch toán một nghiệp vụ không tồn tại; còn **≥1 dòng nhưng chỉ một bên** là dữ liệu sai và phải ném lỗi. Kiểm tra cân đối vì thế chạy *sau* khi lọc bỏ bút toán rỗng, để trường hợp thứ hai vẫn bị bắt.

**Chống ghi trùng bằng khoá duy nhất, không bằng kiểm tra ở tầng ứng dụng.** `entry_no` là khoá duy nhất trong PostgreSQL, nên lần ghi thứ hai nổ ràng buộc và giao dịch roll back. Cách quen thuộc — đọc xem kỳ này đã ghi chưa rồi mới ghi — luôn có cửa race: hai yêu cầu cùng đọc được "chưa", rồi cả hai cùng ghi, và sổ có gấp đôi chi phí lương. Ràng buộc ở DB thì không có cửa nào, vì nó kiểm tra ngay tại thời điểm ghi.

**Fixture kế toán phải lấy từ dữ liệu đã tính thật.** Fixture đầu tiên tôi bịa số và nó tự mâu thuẫn: `siEmployer = 4.532.500` nhưng bốn khoản chi tiết cộng lại chỉ 4.392.130. Bút toán lập tức không cân và test nổ ngay — bất biến đã làm đúng việc. "Cộng tay cho khớp" là cách nhanh nhất để tạo ra một bộ số trông đúng nhưng sai; nay engine còn kiểm tra thẳng điều này (`SI_BREAKDOWN_MISMATCH`), vì hai con số đó mô tả cùng một sự thật và được lưu ở hai chỗ nên chúng *có thể* lệch nhau.

**Vì sao quyền nằm trong database chứ không trong token.** Access token có `roles` nhưng không có `permissions`, và đó là cố ý. Quyền có thể bị thu hồi; nếu token tự tuyên bố "tôi có `gl:post`" thì người vừa bị cắt quyền vẫn giữ nó tới 15 phút sau. Với thao tác ghi sổ kế toán thì 15 phút đó là quá dài. Nên token chỉ chứng minh **danh tính** — thứ không đổi trong 15 phút — còn quyền luôn tra lại DB tại thời điểm yêu cầu. Trả giá hai câu truy vấn mỗi request để đổi lấy việc thu hồi quyền có hiệu lực ngay.

**Phân tách nhiệm vụ: người tính lương không được ghi sổ.** `HR_ADMIN` có `payroll:run` nhưng **không** có `gl:post`; `CHIEF_ACCOUNTANT` thì ngược lại. Một người vừa chạy lương vừa tự ghi sổ thì sai sót không có ai phát hiện — đây là nguyên tắc kiểm soát nội bộ, không phải sở thích phân quyền. `demo:rbac` kiểm chứng cả hai chiều: HR_ADMIN bị 403 khi ghi sổ, và CHIEF_ACCOUNTANT qua được.

**Gate mà không có cửa mở thì không phải bảo mật.** Cờ `mustChangePassword` chặn mọi route — nhưng nếu không có endpoint đổi mật khẩu thì mọi tài khoản do admin tạo bị khoá vĩnh viễn. Đây là lỗ hổng thật tôi tự tạo ra rồi tự phát hiện khi thử đăng nhập: gate hoạt động hoàn hảo và nhốt luôn người dùng ở trong. Lối ra là `POST /api/auth/change-password`, và `allowMustChangePassword` chỉ được bật ở đúng một chỗ đó — `requirePermission` **không nhận** tham số này, nên không route nào vô tình mở được.

**Đổi mật khẩu thì thu hồi mọi phiên.** Nếu mật khẩu cũ đã lộ thì kẻ giữ nó đang có một refresh token hợp lệ; đổi mật khẩu mà không thu hồi thì việc đổi đó vô nghĩa. Client phải đăng nhập lại — đó là hành vi đúng, không phải bất tiện.

**`/login?next=` là chỗ kinh điển nhất để mở open redirect.** Người dùng đã quen bấm qua trang đăng nhập nên không đọc URL. Kiểm tra `startsWith('/')` là KHÔNG ĐỦ: `//evil.com` qua được và trình duyệt hiểu thành "tới evil.com"; `/\\evil.com` cũng vậy vì một số trình duyệt đổi `\` thành `/`. `safeRedirectTarget` chặn cả hai, cộng `javascript:`, `data:` và ký tự điều khiển.

**Token trong localStorage là đánh đổi có ý thức.** Nếu có XSS thì access token lộ. Điều làm cho nó chấp nhận được: token chỉ sống 15 phút, còn refresh token **đã** nằm trong cookie HttpOnly với `Path=/api/auth`. Thứ bị lộ là một vé 15 phút, không phải phiên 14 ngày.

**Demo không được phép phá thứ nó vừa chứng minh là không phá được.** `approval-flow.ts` dọn dẹp bằng `DELETE FROM approval_requests`, và vì `approval_audit` có FK `ON DELETE CASCADE` nên lệnh đó kéo theo việc xoá bản ghi audit — đúng thứ trigger bất biến cấm. Hệ quả: demo chạy được MỘT lần, lần thứ hai nổ ngay ở dòng dọn dẹp. Lỗi không nằm ở trigger mà ở demo; sửa bằng cách dùng `docRef` mới mỗi lần chạy thay vì xoá lịch sử.

**Vì sao mọi thời điểm quy về "phút tuyệt đối".** Ca đêm là nguồn bug vô tận của chấm công nếu làm việc trực tiếp với `Date`: giờ ra nhỏ hơn giờ vào, ngày của giờ ra khác ngày công vụ, và khung phụ cấp đêm nằm vắt qua đúng cái ranh giới đó. Biểu diễn mọi thứ bằng `phút tuyệt đối so với 00:00 ngày công vụ` thì 06:00 hôm sau là `1800`, lớn hơn `1320` của 22:00 — so sánh và ghép cặp trở thành số học thường, không còn chỗ nào để nhầm ngày.

**Việc kiểm tra định nghĩa ca được giao cho chính engine.** `shiftParamsSchema.superRefine` gọi thẳng `resolveShift`: chồng lấn đoạn, giờ nghỉ vượt thời lượng, giờ ra không sau giờ vào, khung đêm vô lý — tất cả chỉ có MỘT bộ luật. Viết lại bộ thứ hai ở tầng validate thì sớm muộn chúng lệch nhau, và bản lệch nhau sẽ cho lưu một ca mà engine không resolve được — tức là lỗi nổ lúc đang xếp lịch chứ không phải lúc người dùng bấm lưu.

**Một lệnh "ensure" mà làm mất dữ liệu thì không còn là ensure.** Bug có sẵn, tìm ra khi `CA_TOI` được đánh số v2 thay vì v1. Hai chỗ cùng sai: (1) nhánh INSERT của `ensureKind` bỏ sót `exclusiveByCode` nên lần tạo đầu tiên luôn nhận `false` từ default của cột; (2) route tạo phiên bản gọi `ensureKind` chỉ với `{code, nameVi, paramsSchema}`, và nhánh UPDATE làm `?? false` — nên **mỗi lần tạo một phiên bản mới, cờ độc quyền của loại đó bị âm thầm đặt về false**. PRINT và REPORT_DEF thoát nạn chỉ vì seed của chúng được chạy lại sau lần POST cuối. Sửa cả hai lớp: `ensureKind` giữ nguyên giá trị hiện có khi người gọi không chỉ định, và `VALIDATORS` khai rõ cờ để route tạo kind đúng ngay lần đầu. Cờ này quyết định cả phạm vi độc quyền lẫn cách đánh số phiên bản, nên sai nó thì `resolvePolicy` không trả lời được "bản nào đang hiệu lực".

**OT ban đêm có BỐN hệ số, không phải ba.** Điều 57 NĐ 145/2020: `[hệ số OT] + 30% + 20% × [lương giờ ban ngày của ngày tương ứng]`. Khoản 20% đó nhân với lương giờ ban ngày, và con số này là **100% hay 150% tuỳ ngày đó đã có OT ban ngày hay chưa** — nên OT đêm ngày thường là 200% hoặc 210%, cuối tuần 270%, ngày lễ 390%. Gộp hai trường hợp ngày thường thành một hệ số là trả sai 10% trên toàn bộ giờ OT đêm, và ca đêm là ca có nhiều OT đêm nhất. Đã kiểm chứng bằng số thật: NV007 có 15,92h OT đêm ngày lễ (390%) + 0,67h ở 200% + 0,50h ở 210% → tính tay 3.739.724đ, khớp đúng phiếu lương.

**Giờ đêm không được trả hai lần.** `ot_night_minutes` là TẬP CON của `ot_weekday/weekend/holiday_minutes`. Nếu đưa cả hai vào công thức thì mỗi giờ OT đêm được trả hai lần — một lần ở 150% và một lần ở 210%. Nên các biến `ot*Hours` đưa vào engine lương là phần **ban ngày, đã trừ phần đêm**, và có test bất biến: tổng bảy biến OT phải đúng bằng tổng OT thô.

**Bảng lương phải hiện được công thức đã chạy.** Trang kỳ lương trước đây chỉ có bốn con số tổng; muốn biết "vì sao ra số này" thì phải đọc jsonb trong database. Với một hệ thống mà công thức lương sửa được trên giao diện thì đó là thiếu mất một nửa giá trị — người ta sửa công thức mà không thấy nó áp vào đâu. Nay mỗi phiếu mở ra được danh sách thành phần kèm **chính chuỗi công thức** và cờ thuế/BH.

**Giờ nghỉ và khe giữa các đoạn không được tính là OT.** Ở hệ số 300% thì sai chỗ này là tiền thật. Nhánh ngày nghỉ/ngày lễ lấy giờ làm theo khoảng bao từ quẹt đầu đến quẹt cuối, và bản đầu tiên trừ không đủ: ca gãy 08:00–12:00 + 14:00–18:00 đi làm ngày lễ được tính **600 phút OT thay vì 480** — trả thừa 50% cho hai tiếng nghỉ giữa ca. Sửa bằng cách trừ cả hai loại khoảng không làm việc: khe giữa các đoạn VÀ khung giờ nghỉ trong từng đoạn. Dữ liệu seed xác nhận: OT lễ giảm từ 129.6h xuống **113.5h**, khớp con số tính tay 112h.

**Một quyết định chỉ được tồn tại ở MỘT chỗ.** Bộ sinh quẹt trong seed tính lại mã ca bằng công thức giống hệt vòng xếp lịch, và hai bản sao lệch nhau đúng một điều kiện (ngày lễ) — kết quả là quẹt được sinh cho người mà lịch ghi là NGHỈ, và OT ngày lễ phình gấp đôi. Sửa bằng cách đọc lại lịch từ DB thay vì tính lại. Cùng họ lỗi với `ensureKind` làm mất `exclusiveByCode`.

**Test chỉ pass nhờ DB chưa có dữ liệu thì không phải test.** `tests/attendance-service.spec.ts` dùng thẳng nhân viên `NV001` của seed và xanh hoàn toàn — cho tới khi chạy `npm run seed:attendance`, lúc đó 12/16 test nổ vì `uq_employee_shifts_person_day`. Nay mỗi test tự tạo nhân viên có mã duy nhất trong một transaction rồi rollback: không để lại rác, và không phụ thuộc thứ tự chạy.

**"Cần xem" mà 74% số dòng đều cần xem thì không ai xem.** `needsReview` ban đầu gộp mọi dòng có cảnh báo, và với dữ liệu thật nó trả về **266/360** — vì engine cảnh báo với MỌI OT > 0, kể cả 9 phút. Sửa hai chỗ: ngưỡng cảnh báo OT thành tham số (`otWarningThresholdMin`, mặc định 60'), và `needsReview` chỉ gồm trạng thái đòi hỏi một QUYẾT ĐỊNH của con người (`MISSING_PUNCH`, `ABSENT`). Kết quả: **8 dòng cần quyết định, 44 dòng có ghi chú** — hai con số, hai nghĩa khác nhau.

**FIRST-IN / LAST-OUT, và vì sao không suy hướng quẹt theo điểm giữa đoạn.** Bản port đầu tiên phân loại quẹt VÀO/RA hoàn toàn theo điểm giữa của đoạn, và nó phá đúng trường hợp phổ biến nhất: người làm 08:00–11:00 rồi về có hai quẹt 480 và 660, điểm giữa đoạn là 750 nên **cả hai đều bị coi là quẹt VÀO**, giờ ra được suy thành 17:00, và 3 giờ làm được tính thành 8 giờ công. Quy tắc đúng: từ hai quẹt trở lên thì lần đầu là VÀO và lần cuối là RA — đó chính là FIRST-IN/LAST-OUT, không cần đoán. Điểm giữa chỉ dùng khi có đúng một quẹt (không còn cách nào khác).

**Giờ nghỉ phải là một KHUNG, không chỉ một thời lượng.** Chỉ có `breakMinutes = 60` thì engine buộc phải trừ trọn 60 phút cho mọi ca, kể cả người làm 08:00–11:00 chưa hề nghỉ trưa — 3 giờ làm còn 2 giờ công. Nên định nghĩa đoạn giờ nhận thêm `breakStart`/`breakEnd`, và engine chỉ trừ **phần giao** giữa khoảng đã làm và khung nghỉ: 08:00–11:00 trừ 0 phút, 08:00–12:30 trừ 30 phút, 08:00–14:00 trừ 60 phút. Khai cả `breakMinutes` lẫn khung mà hai con số lệch nhau thì **ném lỗi** chứ không âm thầm chọn một.

**Thiếu quẹt thì suy ra, nhưng phải đánh dấu.** Quên quẹt xảy ra hàng ngày; coi là vắng thì oan cho người ta, còn im lặng bỏ qua thì mất khả năng kiểm soát. Nên giờ được suy từ kế hoạch, nguồn ghi `INFERRED`, và trạng thái thành `MISSING_PUNCH` để HR rà soát. Ca gãy còn được suy chéo đoạn: quên quẹt lúc đổi đoạn (rất hay xảy ra vì họ không rời xưởng) thì lấy quẹt VÀO của đoạn sau làm giờ RA của đoạn trước, kẹp về giờ kế hoạch.

**Đến sớm không tự thành OT.** Giờ công chính bị KẸP vào khoảng kế hoạch; phần ngoài được tách riêng thành OT để nhân sự quyết định có tính hay không. Cộng thẳng thì người hay đến sớm sẽ có lương cao hơn người làm đúng giờ. Hai khoảng OT gối nhau được **gộp** trước khi tính — không gộp thì phần giao bị đếm hai lần và lương OT trả hai lần cho cùng một khoảng.

**Vì sao không dùng Puppeteer/Chromium để xuất PDF.** Chromium ~170MB tải về và ~300MB RAM khi chạy, trong sandbox 2GB đang chạy chung PostgreSQL và dev server. Đổi lại ta được một file PDF — trong khi trình duyệt đã có sẵn "In → Lưu thành PDF" với chất lượng dàn trang tốt hơn hầu hết thư viện. ERPNext cũng làm đúng vậy: Print Format render HTML, trình duyệt lo phần PDF. Cái khó và đáng giá nằm ở TẦNG TEMPLATE, và đó là thứ `engine/print.ts` làm.

**Dữ liệu in LUÔN được escape.** Mẫu (`body`, `css`) do quản trị soạn nên đáng tin và được chèn nguyên văn. DỮ LIỆU thì không: một ô "lý do nghỉ" chứa `<script>` mà không escape là stored XSS chạy trên máy kế toán trưởng mỗi lần in phiếu lương. Muốn chèn HTML thô phải viết `| raw` một cách có chủ ý — và nó hiện rõ khi đọc mẫu. Tầng schema còn chặn `<script>` và thuộc tính sự kiện ngay lúc lưu.

**Hai quy tắc `@page` là một cái bẫy.** `renderDocument` sinh `@page` theo `paperSize`/`orientation`/`marginMm`; nếu CSS của mẫu cũng khai báo `@page` thì hai quy tắc cascade với nhau và có thể làm mất lề đã cấu hình. Bản in vẫn đẹp trên màn hình, chỉ sai khi in thật — loại lỗi không ai phát hiện cho tới khi kế toán phàn nàn. CSS mẫu seed đã bỏ `@page`, có comment giải thích.

**Không dùng `.default()` trong schema tham số — lần thứ hai.** `.default('')` trên một trường làm kiểu input khác kiểu output, mà `z.ZodType<T>` khai báo `T` cho cả hai, nên mọi chỗ gọi `resolvePolicy` vỡ kiểu. Đã xảy ra với `exemptMealCapMonthly` ở VN_PIT, giờ lặp lại với `expr` ở mẫu in. Thành nguyên tắc: tham số cấu hình không có giá trị ngầm định.

**Refresh token lưu DẠNG HASH, và có phát hiện tái sử dụng.** Rò rỉ bảng `refresh_tokens` thì kẻ tấn công vẫn không đăng nhập được — đúng lý do ta băm mật khẩu. Mỗi lần refresh sinh token mới và thu hồi token cũ; nếu một token đã thu hồi được trình ra lần nữa thì thu hồi CẢ HỌ token. Không có cái này, một refresh token bị lộ sẽ sống suốt 14 ngày mà không ai biết.

**Access token trong body, refresh token trong cookie HttpOnly.** Access phải đọc được bằng JS thì mới gắn vào Authorization header, và nó chỉ sống 15 phút. Refresh không bao giờ được JS đọc — để nó trong body nghĩa là một lỗ XSS lấy được phiên 14 ngày.

**Thông báo đăng nhập sai cố tình mơ hồ.** "Sai tên đăng nhập hoặc mật khẩu" cho cả hai trường hợp, và vẫn băm một mật khẩu giả khi tài khoản không tồn tại — nếu không, thời gian phản hồi sẽ khác nhau và đó cũng là một cách liệt kê tài khoản. Rate limit theo IP chứ không theo tên đăng nhập: khoá theo tên đăng nhập thì kẻ tấn công chỉ cần gõ sai mật khẩu của nạn nhân để khoá nạn nhân ra.

**Rate limit trong DATABASE, không phải bộ nhớ.** In-memory reset mỗi lần restart và vô dụng khi chạy nhiều tiến trình — với một cơ chế an ninh thì "reset khi restart" chính là một lỗ.

**RBAC hai tầng.** QUYỀN trả lời "được làm gì", PHẠM VI trả lời "trên dữ liệu của ai". Cùng quyền `payroll:read` nhưng trưởng phòng chỉ thấy phòng mình. Gộp hai thứ vào một bảng quyền sẽ sinh ra tổ hợp nổ (mỗi quyền × mỗi phòng). Mặc định là TỪ CHỐI.

**Không tự sinh JWT secret.** `requireJwtSecret` NÉM nếu thiếu hoặc ngắn hơn 32 ký tự. Secret sinh lúc chạy nghĩa là mọi token mất hiệu lực mỗi lần restart, và trên nhiều tiến trình thì mỗi tiến trình một secret. Test chốt cả `alg=none`, đổi alg, sai issuer/audience, và token bị sửa payload.

**Ngưỡng duyệt là dữ liệu, máy trạng thái là code.** "Chi trên 200 triệu cần CEO" sửa được trên giao diện. Còn "đơn APPROVED không quay lại PENDING" thì không — cho sửa bảng chuyển trạng thái trên UI thì ai cũng tự duyệt được đơn của mình bằng cách đổi luật. Ba trạng thái cuối có bảng chuyển RỖNG, và test duyệt đồ thị để khẳng định không có đường nào thoát ra.

**Chuỗi duyệt được CHỤP lúc nộp đơn.** Nếu đọc lại từ chính sách mỗi lần hiển thị, một thay đổi ngưỡng giữa chừng sẽ đổi số bước của đơn đang duyệt dở — đơn "bước 2/3" bỗng thành "bước 2/2" và tự chốt ở lần duyệt kế tiếp.

**Audit trail bất biến được ép ở TẦNG DATABASE.** Trigger chặn UPDATE và DELETE trên `approval_audit`. Một audit trail mà ai có quyền DB cũng sửa được thì không trả lời được câu hỏi duy nhất nó tồn tại để trả lời: "ai đã duyệt cái này". `npm run demo:approval` thử sửa và thử xoá, cả hai đều bị chặn.

**Một lỗ hổng trong bản Phase 1 đã sửa khi port.** `evaluateCondition` đọc `ctx[field]` rồi so sánh trực tiếp; trường thiếu thì `Number(undefined)` là `NaN` và `NaN > 5` là `false` — bước duyệt bị BỎ QUA trong im lặng. Một đơn chi 500 triệu thiếu trường `amount` sẽ đi thẳng qua bước CEO. Cùng họ lỗi với `onMissingVar: 'zero'`. Nay mặc định là NÉM LỖI. Ranh giới dễ nhầm: **0 không phải là thiếu** — một đơn 0 đồng là đơn hợp lệ.

**Kiểm tra UUID trước khi truy vấn.** `/approvals/khong-ton-tai` từng trả 500 vì PostgreSQL ném `22P02` trước khi `notFound()` kịp chạy. 500 nghĩa là "server hỏng", 404 nghĩa là "không có cái đó" — và log 500 sẽ che mất lỗi thật.

**Hai phạm vi độc quyền, không phải một.** Tham số luật và định nghĩa có bản chất khác nhau: tại một thời điểm chỉ có MỘT biểu thuế TNCN, nhưng phải có NHIỀU mẫu in và báo cáo cùng ACTIVE. Ràng buộc EXCLUDE cũ gộp chung nên kích hoạt báo cáo thứ hai sẽ archive báo cáo thứ nhất. Nay có hai ràng buộc, chọn theo cờ `policy_kinds.exclusive_by_code`, và **đánh số phiên bản cũng theo đúng phạm vi đó** — tham số luật đánh số theo kind (biểu 7 bậc và 5 bậc là hai bản kế tiếp của cùng một đạo luật), định nghĩa đánh số theo (kind, code).

**Định nghĩa báo cáo không bao giờ chứa SQL.** Người dùng chỉ chọn từ `SOURCES` — danh sách cột whitelist; engine ghép câu truy vấn từ những mảnh viết sẵn và mọi GIÁ TRỊ đi qua tham số `$1, $2…`. Cho nhập SQL trực tiếp nghĩa là bất kỳ ai có quyền soạn báo cáo đều có quyền `DROP TABLE`. Engine kiểm tra lại whitelist một lần nữa lúc chạy, vì một định nghĩa có thể được ghi thẳng vào database bằng SQL, bỏ qua API.

**PostgreSQL không cho dùng alias của SELECT trong `HAVING`.** `HAVING THUC_NHAN > $1` nổ với "column thuc_nhan does not exist" dù `THUC_NHAN` có ngay trong SELECT — chỉ `ORDER BY` và `GROUP BY` được tham chiếu alias. Ở `HAVING` phải phát lại `sum(ps.net_pay)`.

**Alias phải bọc nháy kép.** `AS THUC_NHAN` không bọc thì PostgreSQL hạ xuống `thuc_nhan`, và người dùng chọn mã có dấu sẽ nhận về khoá không đoán được.

**Không nối thêm SQL vào một migration đã chạy.** Drizzle không thực thi lại migration đã áp dụng, nên phần nối thêm im lặng không bao giờ chạy. Những ràng buộc Drizzle không diễn đạt được thì đặt ở `extras.sql` — idempotent, chạy mỗi lần `db:setup`.

**In phiếu lương KHÔNG được tính lại.** Khi in một phiếu đã lập, engine không chạy nữa: chính sách trong database có thể đã đổi kể từ khi kỳ đó được tính, và tính lại sẽ cho ra con số khác với con số đã trả cho người lao động. `loadPayslipPrintData` đọc thẳng `payslips.components` và các cột đã lưu; engine chỉ còn dùng cho trường có `expr`, tức là phép cộng trên những con số đã chốt.

**Resolve chính sách MỘT LẦN cho cả kỳ, ở đầu transaction.** Nếu resolve trong vòng lặp từng nhân viên, một bản chính sách được kích hoạt giữa chừng sẽ làm hai người trong cùng một kỳ bị áp hai bộ luật — và không lỗi nào hiện ra. Resolve trước rồi dùng chung là đúng ngữ nghĩa "một kỳ một luật".

**Không `Promise.all` trên cùng một client transaction.** Ba lần `resolvePolicy` cùng chạy trong một transaction của Drizzle dùng chung MỘT pg client; bắn ba query đồng thời khiến pg cảnh báo "Calling client.query() when the client is already executing" và có thể làm rối thứ tự thực thi. Tuần tự.

**`varchar(2)` cho vùng lương là một cái bẫy.** Tên vùng là số La Mã — 'I', 'II', 'III', 'IV' — nên 'III' cần 3 ký tự. Code compile sạch, seed sạch với vùng I và II, rồi mới nổ ở nhân viên đầu tiên thuộc vùng III, với một thông báo `22001 value too long` không hề nhắc tên cột.

**`payslips.employee_id` dùng `onDelete: 'restrict'`.** Xoá được một nhân viên đã có phiếu lương là phá huỷ lịch sử trả lương, và thứ đó không khôi phục được. Nhân viên nghỉ việc thì `active = false`, không xoá.

**Chia cứng 26 ngày công là sai.** Số ngày công chuẩn dao động 24–27 tuỳ tháng và tuỳ năm nhuận; test `payroll.spec.ts` chứng minh trong 12 tháng của 2026 có nhiều hơn một giá trị. Tháng 2 chia cứng 26 sẽ làm lương thấp hơn thực tế.

**Chuỗi duyệt lấy từ đường duyệt của luật, không từ thứ bậc toàn cục.** Bản đầu tiên của `resolveApprovalChain` dựng chuỗi bằng "mọi cấp có `order` ≤ cấp khớp". Sai: `HR_HEAD` có thứ bậc 3, nằm giữa `DEPT_HEAD` (2) và `CHIEF_ACCOUNTANT` (4), nên sẽ bị kéo vào duyệt một đề nghị thanh toán 300 triệu — dù nhân sự không liên quan gì tới chi tiền. Mỗi luật phải định nghĩa đường duyệt RIÊNG; `order` chỉ để sắp xếp hiển thị. Có test khoá đúng trường hợp này.

**Vì sao ngưỡng duyệt trả về chuỗi chứ không phải một người.** Cách "chỉ người ở bậc khớp" nghe hợp lý nhưng tạo lỗ hổng: đơn nghỉ 10 ngày sẽ bỏ qua quản lý trực tiếp — người duy nhất biết nhân viên đó có thực sự nghỉ được hay không. Chuỗi dài hơn nhưng không có lỗ hổng.

**Hai lỗ hổng thật trong engine công thức, phát hiện bằng test.** Port engine từ Phase 1 xong, test mới lập tức bắt được hai thứ:

1. **Rò rỉ chuỗi prototype.** Evaluator tra biến bằng toán tử `in`, mà `in` đi theo chuỗi prototype — nên `'constructor' in ctx` đúng trong MỌI ngữ cảnh, kể cả ngữ cảnh rỗng. `evalFormula('constructor', {})` trả về chính hàm `Object`, `evalFormula('__proto__', {})` trả về object prototype. Không phải thực thi mã tuỳ ý (không có eval, và `.` là một phần của định danh nên không truy cập lồng được), nhưng đưa một `Function` vào pipeline tính tiền thì mọi phép toán sau đó thành `NaN`. Đã sửa sang `hasOwnProperty`.
2. **Chia cho 0 trả về 0.** `baseSalary * workedDays / standardDays` với `standardDays = 0` sẽ trả 0đ — cả kỳ lương chi 0đ mà không dòng log nào báo. Không sửa mặc định (30 test Phase 1 khoá hành vi đó) mà thêm tuỳ chọn `onDivisionByZero`; engine lương truyền `'throw'`.

**Vì sao không viết lại parser.** `formula.ts` là 515 dòng đã chạy thật trên VPS và đã bắt được lỗi. Viết lại một bộ parser mới "cho gọn" là cách nhanh nhất để đưa lỗ hổng bảo mật vào lại — và hai lỗ hổng trên chứng minh điều ngược lại: chính việc giữ nguyên code cũ rồi VIẾT TEST MỚI cho nó đã lòi ra lỗi.

**Bằng chứng cho "thêm một loại = một dòng".** `VN_BHXH` là loại chính sách thứ hai, và là phép thử thật cho kiến trúc này vì nó KHÔNG có form viết tay. Kiểm chứng bằng `grep`: không một file `.tsx` nào trong `src/` chứa `socialInsurance`, `referenceSalary`, `regionalMinimumWages` hay bất kỳ tên trường nào của bảo hiểm — `SchemaForm` không biết bảo hiểm là gì, nó chỉ đọc JSON Schema. Thứ duy nhất thêm vào tầng API là một dòng trong map `VALIDATORS` (và `nameVi` đã được gộp vào chính map đó, vì trước đây phải sửa hai chỗ). Mở `/policies/VN_BHXH/new`: form tự sinh, gồm cả object lồng nhau cho tỷ lệ NLĐ/NSDLĐ và bảng thêm/xoá dòng cho lương tối thiểu vùng.

**Vì sao hai schema phải luôn đi cùng nhau.** Mỗi loại chính sách có HAI mô tả: JSON Schema (giao diện dùng để tự sinh form) và Zod schema (backend dùng để validate). Chúng phải khớp nhau tuyệt đối. Bug thật đã xảy ra: khi bỏ `.default(0)` khỏi `exemptMealCapMonthly` ở Zod (tham số pháp lý không được có giá trị ngầm định), trường đó thành bắt buộc — nhưng `required` trong JSON Schema không được cập nhật. Hệ quả: form hiển thị nó là tuỳ chọn, người dùng bỏ trống, trường số trống được gửi lên là `0`, và Zod **chấp nhận 0** vì `minimum = 0`. Trần miễn thuế ăn giữa ca thành 0đ, người lao động bị đánh thuế oan trên tiền ăn ca, và không một dòng log nào báo. `tests/schema-form.spec.ts` canh đúng điểm lệch này, và `validateAgainstSchema` chặn ở form — chỉ form mới phân biệt được "quên điền" với "cố ý đặt 0".

**Vì sao không dùng shadcn CLI.** CLI kéo `radix-ui` và hàng chục dependency vào sandbox ~1,4 GB đang chạy chung PostgreSQL. Các primitive cần dùng (Card, Button, Badge, Field, Alert) đơn giản hơn tự viết nhiều lần là trả giá đó.

**`resolve.extensionAlias` trong `next.config.ts`.** Code trong `src/` viết theo ESM chuẩn: `import './schema.js'` dù file thật là `schema.ts`. Node thuần và tsx bắt buộc phải có extension như vậy, nhưng webpack không tự hiểu quy ước đó. Giữ extension đúng chuẩn tốt hơn là bỏ hết extension rồi mất khả năng chạy script/test trực tiếp bằng tsx.

**Vì sao Drizzle chứ không Prisma.** Prisma sinh kiểu TypeScript **lúc build** từ `schema.prisma`. Thêm một trường nghĩa là sửa schema → migrate → build → deploy — ngược hoàn toàn với tùy biến lúc chạy. Drizzle vẫn type-safe nhưng cho phép query động.

**Vì sao không dùng metadata cho mọi thứ.** Xem bảng "ranh giới" ở trên. Metadata toàn phần khiến hệ thống không debug được: lỗi nằm trong dữ liệu, không nằm trong code, không có stack trace.

**Vì sao `resolvePolicy` ném lỗi thay vì trả mặc định.** Một kỳ lương tính bằng con số không có căn cứ pháp lý nguy hiểm hơn nhiều so với việc dừng lại và báo "chưa cấu hình chính sách cho khoảng này".

**Vì sao `PayRun.policySnapshot` đóng băng tham số.** Ba năm sau cơ quan thuế kiểm tra, hoặc có người vào sửa `policy_versions`, thì phiếu lương cũ vẫn phải tái hiện đúng con số đã tính. Nếu chỉ lưu tham chiếu rồi tra ngược, một lần chỉnh sửa quá khứ sẽ làm sai lệch toàn bộ lịch sử lương.

**Vì sao lưu cả NỘI DUNG file thanh toán, không chỉ SHA-256.** Bản đầu tiên chỉ lưu băm và kích thước, định sinh lại file khi cần tải. Nhưng sinh lại chỉ ra đúng byte cũ nếu phiếu lương, tài khoản và phiên bản tham số đều chưa đổi — mà tháng sau có người sửa số tài khoản là file của tháng này tái tạo ra khác, và cái đã gửi ngân hàng không còn truy được. Với chứng từ chi tiền thì chữ "nếu" là quá nhiều: 100 KB cho 1.000 nhân viên là giá quá rẻ để bỏ nó đi. Route tải vẫn kiểm băm trước khi trả — nếu lệch thì trả 500 và từ chối, vì gửi nhầm một lệnh chuyển tiền đắt hơn một màn hình báo lỗi.

**Vì sao "một kỳ một lô" là unique index RIÊNG PHẦN, không phải kiểm tra trong code.** `UNIQUE (pay_run_id, bank_code) WHERE status <> 'VOID'` — ràng buộc này sống ở tầng DB nên nó chặn cả những đường vào không đi qua service: một script chạy tay, một endpoint ai đó thêm sau. Kiểm tra `SELECT count(*)` rồi `INSERT` thì có cửa sổ đua: hai request song song cùng đọc được 0 và cùng ghi, và tiền đi hai lần. Cùng lý do đã áp dụng cho bút toán GL và `EXCLUDE` của khoảng hiệu lực.

**Vì sao thiếu tài khoản thì loại khỏi file chứ không dừng cả lô.** Một người chưa kịp mở tài khoản không được phép khiến 400 người còn lại không nhận được lương. Nhưng cũng không được bỏ qua im lặng — người bị loại xuất hiện trong `missing[]` kèm đúng số tiền chưa trả, ngay trên màn hình lúc xuất, để kế toán đối chiếu trước khi gửi thay vì phát hiện vào kỳ sau. Tài khoản **chưa đối chiếu** thì vẫn vào file (chặn thì tê liệt) nhưng nêu trong `unverified[]`: chuyển tiền vào số chưa xác nhận là lỗi không sửa được sau khi gửi.

**Vì sao `payment:export` thuộc kế toán, không thuộc nhân sự.** `HR_ADMIN` có `payroll:run` nhưng không có `payment:export`; `CHIEF_ACCOUNTANT` thì ngược lại. Nếu một tài khoản làm được cả hai thì nó tự tăng lương cho mình rồi tự chuyển, và không có ai ở giữa để phát hiện. Cùng nguyên tắc tách nhiệm vụ đã áp dụng cho `gl:post`.

**Ba lỗi seed chỉ lộ ra trên một DB trắng.** Suốt mười bốn phase, mọi thứ đều chạy trên cùng một DB phát triển đã được seed bằng tay qua nhiều lần. Dựng lại từ đầu bằng `docker/migrate.sh` thì cả ba hiện ra cùng lúc, và cả ba đều là loại "vẫn chạy, vẫn exit 0, chỉ là sai":

1. **`VN_PIT` không có script seed.** Ba bộ tham số đã nằm sẵn trong `tax-params.ts`, nhưng thứ duy nhất đưa chúng vào DB là `demo-law-change.ts` — một script DEMO. Trên DB trắng, `seed:all` chạy tới `seed:salary` là nổ `NOT_RESOLVABLE`, và cách "sửa" duy nhất là chạy script demo để lấy dữ liệu pháp lý. Nay có `seed:tax`.
2. **Vòng phụ thuộc giữa nhân viên và chấm công.** `seed:attendance` cần nhân viên (khoá ngoại), nhân viên lại do `payroll` tạo, mà `payroll` thì cần chấm công. Không có thứ tự nào đúng. Tách `seed:employees` ra, và đưa roster về một module dùng chung — hai bản sao của cùng một roster là hai bản sẽ lệch.
3. **`payroll` âm thầm trả đủ lương khi không có chấm công.** Bản trước in `[!] CHƯA CÓ CHẤM CÔNG … tính đủ 26 ngày công theo mặc định` rồi **tính tiếp**. Kỳ không có chấm công nghĩa là HOẶC chưa import dữ liệu HOẶC cả công ty nghỉ — cả hai cần người quyết, không phải một giá trị mặc định. Nay từ chối chạy, trừ khi bật `ALLOW_NO_ATTENDANCE=true` một cách tường minh.

Bài học không phải là ba bug đó, mà là **một DB phát triển sống lâu sẽ che mất mọi lỗi khởi tạo**. Nếu không viết Dockerfile thì cả ba sẽ nằm im cho tới lần deploy đầu tiên.

**Vì sao `migrate` là một service riêng trong compose.** Nếu migration nằm trong entrypoint của app thì một lần migrate lỗi để lại một container "đang chạy" nhưng không dùng được, và mỗi lần app restart lại migrate lại. Tách ra thì migrate lỗi = exit code khác 0, hiện ngay trong `docker compose ps`, và `app` không start nhờ `condition: service_completed_successfully`. Service đó dùng **tầng builder** vì `drizzle-kit` và `tsx` là devDependency, không có trong standalone bundle — nhét chúng vào image chạy thật thì mất hết lợi ích của `output: 'standalone'`.

**Vì sao `/api/health` phải ping DB.** Một container Next.js vẫn trả 200 cho trang tĩnh khi DB đã chết. HEALTHCHECK chỉ đo "Next có sống không" sẽ báo xanh trong khi không ai đăng nhập hay xem được bảng lương nào — tức là đúng lúc cần báo động nhất thì nó im.

**Giảm trừ gia cảnh KHÔNG chia theo ngày công.** Người vào làm giữa tháng vẫn được trừ đủ 15,5 triệu. Chia nhỏ theo tỷ lệ ngày là sai luật và làm người lao động nộp thuế oan.
