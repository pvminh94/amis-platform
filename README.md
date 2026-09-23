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
scripts/seed-auth.ts        14 quyền, 5 vai trò, 6 người dùng
scripts/auth-flow.ts        32 kiểm tra end-to-end
tests/auth.spec.ts          32 test: các đường tấn công JWT, bcrypt, so sánh thời gian
```

### Đã kiểm chứng

**Trên PostgreSQL 18.4 thật — không mock.** Lý do: ba ràng buộc quan trọng nhất nằm ở tầng DB, mà mock không thực thi chúng. Test trên mock sẽ xanh trong khi hệ thống thật vẫn cho phép hai mức thuế chồng lấn.

```
npm run verify
  ✓ tsc --noEmit        0 lỗi
  ✓ drizzle-kit migrate áp dụng từ DB trắng
  ✓ db:extras           EXCLUDE constraint
  ✓ vitest              395/395 test
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
npm run demo:gl             # ghi sổ kỳ 09/2026, in bút toán + bảng đối chiếu
npm run demo:rbac           # 17 kiểm tra phân quyền + phân tách nhiệm vụ
npm run seed:all            # cả bảy loại chính sách
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

---

## Ghi chú thiết kế

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

**Giảm trừ gia cảnh KHÔNG chia theo ngày công.** Người vào làm giữa tháng vẫn được trừ đủ 15,5 triệu. Chia nhỏ theo tỷ lệ ngày là sai luật và làm người lao động nộp thuế oan.
