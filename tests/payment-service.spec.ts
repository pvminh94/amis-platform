/**
 * ============================================================================
 * TEST SERVICE THANH TOÁN — chạy trên PostgreSQL THẬT
 * ============================================================================
 *
 * `tests/payment.spec.ts` kiểm tra ENGINE (định dạng file). File này kiểm tra TẦNG
 * SERVICE: những thứ chỉ sai được khi có DB — ràng buộc một-lô-chưa-VOID, tài
 * khoản chính duy nhất, và máy trạng thái.
 *
 * Không mock DB. Giá trị của các test này nằm ở chỗ PostgreSQL NÉM LỖI; mock thì
 * không ném, và test sẽ xanh trong khi hệ thống thật cho xuất hai lô cho cùng một
 * kỳ — tức là trả lương hai lần.
 *
 * Mỗi test chạy trong một transaction rồi rollback.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const envText = readFileSync(new URL('../.env', import.meta.url), 'utf8');
for (const line of envText.split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!;
}

const { getDb, closeDb } = await import('../src/db/client.js');
const {
  bankPaymentBatches,
  employeeBankAccounts,
  employees,
  payslips,
  payRuns,
} = await import('../src/db/schema.js');
const { PaymentFileError } = await import('../src/engine/payment-file.js');
const {
  createPaymentBatch,
  updateBatchStatus,
  verifyBatchChecksum,
  employeesWithoutAccount,
} = await import('../src/lib/payment.js');
const { eq, sql } = await import('drizzle-orm');

type Db = ReturnType<typeof getDb>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

async function rolled<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const db = getDb();
  let out: T | undefined;
  const MARK = 'ROLLBACK_PAYMENT_TEST';
  try {
    await db.transaction(async (tx) => {
      out = await fn(tx);
      throw new Error(MARK);
    });
  } catch (e) {
    if ((e as Error).message !== MARK) throw e;
  }
  return out as T;
}

/** Nhãn duy nhất theo thời gian chạy — mã cố định sẽ đụng dữ liệu seed. */
const RUN_TAG = `PM${Date.now()}`;

/**
 * Năm dành riêng cho test. `uq_pay_run_period` là UNIQUE trên (năm, tháng), và
 * bản đầu tiên dùng cứng 2026 với tháng tăng dần — đến test thứ mười thì đụng
 * đúng kỳ 09/2026 mà `npm run payroll` đã tạo, nổ ngay ở INSERT. Lỗi đó không nói
 * gì về code đang kiểm tra, chỉ nói rằng test đang giành dữ liệu với seed.
 */
const TEST_YEAR = 2031;

/** Tạo nhân viên thật (bảng tài khoản có khoá ngoại vào employees). */
async function makeEmployee(
  tx: Tx,
  code: string,
  opts: { active?: boolean } = {},
): Promise<string> {
  const [e] = await tx
    .insert(employees)
    .values({
      employeeCode: code,
      fullName: `Người Thử ${code.slice(-2)}`,
      department: 'Kỹ thuật',
      wageRegion: 'I',
      baseSalary: 10_000_000,
      dependents: 0,
      active: opts.active ?? true,
    })
    .returning({ id: employees.id });
  return e!.id;
}

async function makeAccount(
  tx: Tx,
  code: string,
  opts: { primary?: boolean; active?: boolean; verified?: boolean } = {},
): Promise<void> {
  await tx.insert(employeeBankAccounts).values({
    employeeCode: code,
    accountNumber: `0011${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`,
    accountName: `NGUOI THU ${code.slice(-2)}`,
    bankCode: 'VCBVNVX',
    bankName: 'Vietcombank',
    isPrimary: opts.primary ?? true,
    verifiedAt: opts.verified === false ? null : new Date('2026-08-01T00:00:00+07:00'),
    active: opts.active ?? true,
  });
}

/**
 * Tạo một kỳ lương. `month` PHẢI khác nhau giữa các test: `uq_pay_run_period`
 * là UNIQUE trên (năm, tháng), và bản đầu tiên dùng cứng 09/2026 nên test thứ
 * hai trở đi nổ ngay ở INSERT — không phải lỗi của code đang测.
 */
let nextMonth = 1;
async function makeRun(
  tx: Tx,
  opts: { slips: number; withAccount: number; unverified?: number[]; noAccount?: number[] },
): Promise<{ runId: string; codes: string[] }> {
  const month = nextMonth++;
  const codes: string[] = [];
  const empIds: string[] = [];

  for (let i = 0; i < opts.slips; i++) {
    const code = `${RUN_TAG}-${month}-${String(i).padStart(2, '0')}`;
    codes.push(code);
    empIds.push(await makeEmployee(tx, code));
    if (!opts.noAccount?.includes(i) && i < opts.withAccount + (opts.noAccount?.length ?? 0)) {
      await makeAccount(tx, code, { verified: !opts.unverified?.includes(i) });
    }
  }

  const [run] = await tx
    .insert(payRuns)
    .values({ periodMonth: month, periodYear: TEST_YEAR, status: 'LOCKED', policySnapshot: {} })
    .returning({ id: payRuns.id });

  for (let i = 0; i < opts.slips; i++) {
    await tx.insert(payslips).values({
      payRunId: run!.id,
      employeeId: empIds[i]!,
      employeeCode: codes[i]!,
      fullName: `Người Thử ${codes[i]!.slice(-2)}`,
      variables: {},
      policySnapshot: {},
      components: [],
      earningsTotal: 9_000_000 + i,
      deductionsTotal: 0,
      taxableIncome: 9_000_000 + i,
      insuranceBase: 9_000_000,
      siBase: 9_000_000,
      uiBase: 9_000_000,
      siEmployee: 0,
      siEmployer: 0,
      pit: 0,
      netPay: 9_000_000 + i,
    });
  }

  return { runId: run!.id, codes };
}

afterAll(async () => {
  await closeDb();
});

describe('createPaymentBatch — tầng service, PostgreSQL thật', () => {
  it('nhân viên KHÔNG có tài khoản bị loại khỏi file và xuất hiện trong missing[]', async () => {
    await rolled(async (tx) => {
      const { runId, codes } = await makeRun(tx, { slips: 3, withAccount: 2, noAccount: [2] });
      const r = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });

      expect(r.file.rowCount).toBe(2);
      expect(r.missing).toHaveLength(1);
      expect(r.missing[0]!.employeeCode).toBe(codes[2]);
      // Số tiền của người bị loại phải được nêu rõ — đó là tiền chưa được trả.
      expect(r.missing[0]!.netPay).toBe(9_000_002);
      expect(r.warnings.join(' ')).toContain('thiếu tài khoản');
    });
  });

  it('tài khoản CHƯA đối chiếu vẫn vào file nhưng bị nêu trong unverified[]', async () => {
    await rolled(async (tx) => {
      const { runId, codes } = await makeRun(tx, { slips: 2, withAccount: 2, unverified: [1] });
      const r = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });

      // KHÔNG chặn. Chặn thì một tài khoản mới mở khiến cả công ty không nhận
      // được lương. Cảnh báo, và để kế toán quyết.
      expect(r.file.rowCount).toBe(2);
      expect(r.unverified).toHaveLength(1);
      expect(r.unverified[0]!.employeeCode).toBe(codes[1]);
    });
  });

  it('tổng lô bằng đúng tổng thực nhận của các phiếu CÓ tài khoản', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 4, withAccount: 4 });
      const r = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      // netPay = 9.000.000 + i, i = 0..3  →  36.000.006
      expect(r.file.totalAmount).toBe(36_000_006);
      expect(r.file.rowCount).toBe(4);
    });
  });

  it('nội dung file ĐƯỢC LƯU và băm của nó khớp checksum đã ghi', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 2, withAccount: 2 });
      const r = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });

      expect((await verifyBatchChecksum(tx, r.batchId, r.file.content)).ok).toBe(true);

      // Và nội dung đọc lại từ DB phải đúng là nội dung đã sinh.
      const [stored] = await tx
        .select({ c: bankPaymentBatches.content })
        .from(bankPaymentBatches)
        .where(eq(bankPaymentBatches.id, r.batchId))
        .limit(1);
      expect(stored!.c).toBe(r.file.content);
    });
  });

  it('verifyBatchChecksum PHÁT HIỆN nội dung bị sửa dù chỉ một ký tự', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 1, withAccount: 1 });
      const r = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      const v = await verifyBatchChecksum(tx, r.batchId, r.file.content.replace('CONG', 'CONH'));
      expect(v.ok).toBe(false);
      expect(v.actual).not.toBe(v.expected);
    });
  });

  it('kỳ chưa có phiếu nào → EMPTY_FILE, không sinh lô rỗng', async () => {
    await rolled(async (tx) => {
      const [run] = await tx
        .insert(payRuns)
        .values({ periodMonth: nextMonth++, periodYear: TEST_YEAR, status: 'LOCKED', policySnapshot: {} })
        .returning({ id: payRuns.id });

      await expect(
        createPaymentBatch(tx, { payRunId: run!.id, regimeCode: 'BANK_VCB', actor: 'test' }),
      ).rejects.toMatchObject({ code: 'EMPTY_FILE' });
    });
  });

  it('kỳ lương không tồn tại → PaymentFileError', async () => {
    await rolled(async (tx) => {
      await expect(
        createPaymentBatch(tx, {
          payRunId: '00000000-0000-4000-8000-000000000000',
          regimeCode: 'BANK_VCB',
          actor: 'test',
        }),
      ).rejects.toBeInstanceOf(PaymentFileError);
    });
  });

  it('XUẤT LẦN HAI cho cùng (kỳ, ngân hàng) bị ràng buộc DB chặn — 23505', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 1, withAccount: 1 });
      await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });

      // Test QUAN TRỌNG NHẤT của file này: một kỳ lương chỉ được có MỘT file gửi
      // ngân hàng. Mất ràng buộc này thì một cú đúp chuột tạo ra hai lệnh chuyển
      // tiền, và tiền đi hai lần.
      let err: { code?: string; constraint?: string } | undefined;
      try {
        await createPaymentBatch(tx, {
          payRunId: runId,
          regimeCode: 'BANK_VCB',
          date: '2026-09-30',
          actor: 'test',
        });
      } catch (e) {
        err = e as { code?: string; constraint?: string };
      }
      expect(err).toBeDefined();
      expect(err!.code).toBe('23505');
      expect(err!.constraint).toBe('uq_bank_batches_one_active');
    });
  });

  it('sau khi VOID lô cũ thì xuất lô mới được, và số lô tăng', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 1, withAccount: 1 });
      const first = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      expect(first.batchNo).toMatch(/-01$/);

      await updateBatchStatus(tx, first.batchId, 'VOID', { notes: 'sai tên người nhận' });

      const second = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      // Số lô phải KHÁC — hai file trùng tên thì không truy ra cái nào đã gửi.
      expect(second.batchNo).not.toBe(first.batchNo);
      expect(second.batchNo).toMatch(/-02$/);
    });
  });
});

describe('updateBatchStatus — máy trạng thái', () => {
  it('GENERATED → SENT được; GENERATED → RETURNED thì không', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 1, withAccount: 1 });
      const b = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });

      // Chưa gửi thì không thể "bị trả lại".
      await expect(updateBatchStatus(tx, b.batchId, 'RETURNED', {})).rejects.toBeInstanceOf(
        PaymentFileError,
      );

      await updateBatchStatus(tx, b.batchId, 'SENT', {});
      const [after] = await tx
        .select({ s: bankPaymentBatches.status })
        .from(bankPaymentBatches)
        .where(eq(bankPaymentBatches.id, b.batchId))
        .limit(1);
      expect(after!.s).toBe('SENT');
    });
  });

  it('SENT → RETURNED ghi được số món bị trả', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 2, withAccount: 2 });
      const b = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      await updateBatchStatus(tx, b.batchId, 'SENT', {});
      await updateBatchStatus(tx, b.batchId, 'RETURNED', {
        returnedCount: 1,
        notes: 'sai số tài khoản',
      });

      const [r] = await tx
        .select({ s: bankPaymentBatches.status, rc: bankPaymentBatches.returnedCount })
        .from(bankPaymentBatches)
        .where(eq(bankPaymentBatches.id, b.batchId))
        .limit(1);
      expect(r!.s).toBe('RETURNED');
      expect(r!.rc).toBe(1);
    });
  });

  it('VOID là trạng thái CUỐI — không đi đâu được nữa', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 1, withAccount: 1 });
      const b = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      await updateBatchStatus(tx, b.batchId, 'VOID', { notes: 'huỷ' });

      // Phục hồi một lô đã huỷ = biến một file chưa từng gửi thành "đã gửi".
      for (const s of ['SENT', 'RETURNED', 'VOID'] as const) {
        await expect(updateBatchStatus(tx, b.batchId, s, {})).rejects.toBeInstanceOf(
          PaymentFileError,
        );
      }
    });
  });
});

describe('ràng buộc tài khoản chính duy nhất', () => {
  it('hai tài khoản CÙNG is_primary=true cho một người bị DB chặn', async () => {
    await rolled(async (tx) => {
      const code = `${RUN_TAG}-DUP`;
      await makeEmployee(tx, code);
      await makeAccount(tx, code);

      let err: { code?: string; constraint?: string } | undefined;
      try {
        await makeAccount(tx, code);
      } catch (e) {
        err = e as { code?: string; constraint?: string };
      }
      // Hai tài khoản "chính" thì service không biết chuyển vào cái nào — nó lấy
      // cái đầu tiên nó gặp, và thứ tự đó do DB quyết chứ không do ai quyết.
      expect(err?.code).toBe('23505');
      expect(err?.constraint).toBe('uq_bank_accounts_one_primary');
    });
  });

  it('hai tài khoản KHÔNG chính thì được — một người có thể có nhiều tài khoản', async () => {
    await rolled(async (tx) => {
      const code = `${RUN_TAG}-MULTI`;
      await makeEmployee(tx, code);
      await makeAccount(tx, code, { primary: false });
      await makeAccount(tx, code, { primary: false });

      const rows = await tx
        .select()
        .from(employeeBankAccounts)
        .where(eq(employeeBankAccounts.employeeCode, code));
      expect(rows).toHaveLength(2);
    });
  });
});

describe('employeesWithoutAccount', () => {
  it('chỉ nêu nhân viên ĐANG LÀM VIỆC chưa có tài khoản chính', async () => {
    await rolled(async (tx) => {
      const active = `${RUN_TAG}-NA1`;
      const inactive = `${RUN_TAG}-NA2`;
      await makeEmployee(tx, active, { active: true });
      await makeEmployee(tx, inactive, { active: false });

      const list = await employeesWithoutAccount(tx);
      // Người đã nghỉ việc không cần tài khoản. Nêu họ ra chỉ làm loãng danh sách
      // và che mất người thật sự đang chờ lương — đúng bài học của chỉ số "cần rà
      // soát" bên chấm công (266/360 dòng nhiễu, không ai đọc).
      expect(list).toContain(active);
      expect(list).not.toContain(inactive);
    });
  });

  it('tài khoản đã NGƯNG hiệu lực không tính là có tài khoản', async () => {
    await rolled(async (tx) => {
      const code = `${RUN_TAG}-OFF`;
      await makeEmployee(tx, code);
      await makeAccount(tx, code, { active: false });

      // Tài khoản đã đóng mà vẫn được coi là "có" thì file lương sẽ chuyển tiền
      // vào một số không còn hoạt động — ngân hàng trả lại, phải làm lại cả lô.
      expect(await employeesWithoutAccount(tx)).toContain(code);
    });
  });
});

describe('số lô', () => {
  it('theo mẫu PR{YYYY}{MM}-{BANK}-{NN} và UNIQUE toàn bảng', async () => {
    await rolled(async (tx) => {
      const { runId } = await makeRun(tx, { slips: 1, withAccount: 1 });
      const b = await createPaymentBatch(tx, {
        payRunId: runId,
        regimeCode: 'BANK_VCB',
        date: '2026-09-30',
        actor: 'test',
      });
      // Kỳ của test này do makeRun cấp nên chỉ kiểm tra HÌNH DẠNG, không cứng tháng.
      expect(b.batchNo).toMatch(/^PR2031\d{2}-VCB-\d{2}$/);
      expect(b.batchNo.length).toBeLessThanOrEqual(40);

      const n = await tx.execute(
        sql`select count(*)::int as n from bank_payment_batches where batch_no = ${b.batchNo}`,
      );
      expect((n as unknown as { rows: { n: number }[] }).rows[0]!.n).toBe(1);
    });
  });
});
