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
```

### Đã kiểm chứng

**Trên PostgreSQL 18.4 thật — không mock.** Lý do: ba ràng buộc quan trọng nhất nằm ở tầng DB, mà mock không thực thi chúng. Test trên mock sẽ xanh trong khi hệ thống thật vẫn cho phép hai mức thuế chồng lấn.

```
npm run verify
  ✓ tsc --noEmit        0 lỗi
  ✓ drizzle-kit migrate áp dụng từ DB trắng
  ✓ db:extras           EXCLUDE constraint
  ✓ vitest              155/155 test
```

Test đáng chú ý:

- Ghi **SQL thô** cố tình vi phạm → DB từ chối (chứng minh ràng buộc ở DB, không phải ở code)
- Engine `calculatePit(NaN, …)` → **ném lỗi**, không trả 0đ âm thầm
- Quét 1M → 200M: biểu 5 bậc luôn ≤ biểu 7 bậc (nếu có mức nào ngược lại thì một bộ tham số bị nhập sai)
- `resolvePolicy` vào khoảng trống → **ném lỗi rõ ràng**, không dùng giá trị mặc định
- **JSON Schema và Zod schema phải cùng tập trường** — bắt được bug thật, xem ghi chú thiết kế bên dưới
- Giá trị do `defaultsFromSchema` sinh ra **không được phép lưu** (form không cho lưu bộ tham số rỗng)

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
npm run seed:all            # cả bốn loại chính sách
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
| **4** | Workflow designer (React Flow) + rule engine biểu thức | ⬜ |
| **5** | Report builder + print format (HTML/CSS → PDF) | ⬜ |
| **6** | Chuyển nghiệp vụ HRM sang platform (Employee, PayRun thành entity có chính sách) | ⬜ |

---

## Ghi chú thiết kế

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
