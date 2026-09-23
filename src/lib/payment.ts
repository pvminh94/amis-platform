/**
 * ============================================================================
 * LẬP LÔ THANH TOÁN LƯƠNG QUA NGÂN HÀNG
 * ============================================================================
 *
 * Nối phiếu lương + tài khoản ngân hàng + tham số ngân hàng thành một lô UNC,
 * rồi ghi lại lô đó kèm checksum.
 *
 * HAI QUYẾT ĐỊNH QUAN TRỌNG:
 *
 *  1. NHÂN VIÊN THIẾU TÀI KHOẢN KHÔNG ĐƯỢC BỎ QUA IM LẶNG. Cách dễ viết nhất là
 *     `.filter(r => r.accountNumber)` — và thế là một người không nhận được lương
 *     mà không có dòng nào báo. Nên hàm này trả về cả `missing[]`, và người gọi
 *     PHẢI hiện nó ra.
 *
 *  2. MỖI LẦN XUẤT LÀ MỘT DÒNG TRONG `bank_payment_batches`, kèm CHECKSUM và ràng
 *     buộc duy nhất (một kỳ lương + một ngân hàng chỉ có một lô chưa VOID). Hai
 *     người cùng xuất lô tháng 9 rồi gửi cả hai lên iBanking thì nhân viên nhận
 *     lương hai lần — ràng buộc ở tầng DB là cái chặn cuối.
 */

import { and, eq } from 'drizzle-orm';

import {
  bankPaymentBatches,
  employeeBankAccounts,
  employees,
  payslips,
  payRuns,
} from '@/db/schema';
import type { Db } from '@/db/client';
import {
  generatePaymentFile,
  PaymentFileError,
  renderDescription,
  type BankCode,
  type GeneratedPaymentFile,
  type PaymentRow,
} from '@/engine/payment-file';
import { resolvePolicy } from '@/policy/registry';
import { bankPayoutParamsSchema, type BankPayoutParams } from '@/policy/bank-params';

export interface PaymentBatchInput {
  payRunId: string;
  /** Mã cấu hình ngân hàng, vd 'BANK_VCB'. */
  regimeCode: string;
  /** Ngày lập file, 'YYYY-MM-DD'. Mặc định là hôm nay theo giờ VN. */
  date?: string;
  actor: string;
}

export interface CreateBatchResult {
  batchId: string;
  batchNo: string;
  fileName: string;
  file: GeneratedPaymentFile;
  /** Nhân viên có phiếu lương nhưng KHÔNG có tài khoản còn hiệu lực. */
  missing: { employeeCode: string; fullName: string; netPay: number }[];
  /** Tài khoản chưa đối chiếu với ngân hàng — vẫn xuất, nhưng phải biết. */
  unverified: { employeeCode: string; accountNumber: string }[];
  warnings: string[];
}

/** Hôm nay theo giờ VN (UTC+7), dạng YYYY-MM-DD. */
function todayVn(): string {
  return new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
}

export async function createPaymentBatch(
  db: Db,
  input: PaymentBatchInput,
): Promise<CreateBatchResult> {
  // --- Kỳ lương ------------------------------------------------------------
  const [run] = await db.select().from(payRuns).where(eq(payRuns.id, input.payRunId)).limit(1);
  if (!run) throw new PaymentFileError('INVALID_PAYMENT_DATA', `Không tìm thấy kỳ lương ${input.payRunId}`);

  // --- Tham số ngân hàng ---------------------------------------------------
  const pol = await resolvePolicy<BankPayoutParams>(
    'BANK_PAYOUT',
    input.date ?? todayVn(),
    bankPayoutParamsSchema,
    db,
    input.regimeCode,
  );
  const params = pol.params;

  // --- Phiếu lương ---------------------------------------------------------
  const slips = await db
    .select({
      employeeCode: payslips.employeeCode,
      fullName: payslips.fullName,
      netPay: payslips.netPay,
    })
    .from(payslips)
    .where(eq(payslips.payRunId, input.payRunId));
  if (slips.length === 0) {
    throw new PaymentFileError('EMPTY_FILE', `Kỳ lương ${input.payRunId} chưa có phiếu nào`);
  }

  // --- Tài khoản ngân hàng (chỉ lấy tài khoản CHÍNH còn hiệu lực) -----------
  const accounts = await db
    .select()
    .from(employeeBankAccounts)
    .where(
      and(
        eq(employeeBankAccounts.isPrimary, true),
        eq(employeeBankAccounts.active, true),
      ),
    );
  const byEmp = new Map(accounts.map((a) => [a.employeeCode, a]));

  const rows: PaymentRow[] = [];
  const missing: CreateBatchResult['missing'] = [];
  const unverified: CreateBatchResult['unverified'] = [];

  for (const s of slips) {
    const acc = byEmp.get(s.employeeCode);
    if (!acc) {
      // KHÔNG bỏ qua im lặng. Một người không có trong file lương là một người
      // không nhận được lương, và nếu không ai báo thì đến kỳ sau mới phát hiện.
      missing.push({ employeeCode: s.employeeCode, fullName: s.fullName, netPay: s.netPay });
      continue;
    }
    if (acc.verifiedAt === null) {
      unverified.push({ employeeCode: s.employeeCode, accountNumber: acc.accountNumber });
    }
    rows.push({
      employeeCode: s.employeeCode,
      fullName: s.fullName,
      accountNumber: acc.accountNumber,
      beneficiaryName: acc.accountName,
      beneficiaryBankCode: acc.bankCode,
      beneficiaryBranch: acc.branch ?? undefined,
      amount: s.netPay,
      description: renderDescription(params.descriptionTemplate, {
        EMPLOYEE_CODE: s.employeeCode,
        FULL_NAME: s.fullName,
        PERIOD_MONTH: String(run.periodMonth).padStart(2, '0'),
        PERIOD_YEAR: String(run.periodYear),
        PERIOD: `${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
        NET_PAY: String(s.netPay),
      }),
    });
  }

  const periodLabel = `${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`;

  // --- Số hiệu lô ----------------------------------------------------------
  // Đọc số lô hiện có của kỳ này để đánh số tiếp. Không dùng timestamp vì tên file
  // phải đọc được và sắp xếp được theo thứ tự.
  const existing = await db
    .select({ batchNo: bankPaymentBatches.batchNo })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.payRunId, input.payRunId));
  const seq = existing.length + 1;
  const batchNo = `PR${run.periodYear}${String(run.periodMonth).padStart(2, '0')}-${params.bankCode}-${String(seq).padStart(2, '0')}`;

  // --- Sinh file -----------------------------------------------------------
  const file = generatePaymentFile({
    batchNo,
    date: input.date ?? todayVn(),
    payer: {
      name: params.payerName,
      accountNumber: params.payerAccountNumber,
      bankCode: params.payerBankCode,
      branch: params.payerBranch,
      taxCode: params.payerTaxCode,
    },
    bank: params.bankCode as BankCode,
    purpose: 'SALARY',
    periodLabel,
    rows,
    minAccountLength: params.minAccountLength,
    format: params.format,
    delimiter: params.delimiter,
    withBom: params.withBom,
  });

  // --- Ghi lô --------------------------------------------------------------
  // Ràng buộc uq_bank_batches_one_active ở tầng DB sẽ chặn nếu kỳ này đã có một
  // lô chưa VOID cho cùng ngân hàng — không cần kiểm tra ở đây rồi đua điều kiện.
  const [batch] = await db
    .insert(bankPaymentBatches)
    .values({
      // Chỉ số lô, không kèm tên file. Bản đầu tiên ghép cả hai và dài 98 ký tự
      // trong khi cột là varchar(40) — PostgreSQL chặn lại (22001), tức là lô
      // không ghi được. Tên file đã có cột riêng của nó.
      batchNo,
      payRunId: input.payRunId,
      bankCode: params.bankCode,
      purpose: 'SALARY',
      fileName: file.fileName,
      format: file.format,
      rowCount: file.rowCount,
      totalAmount: file.totalAmount,
      checksum: file.checksum,
      byteLength: file.byteLength,
      content: file.content,
      policyVersionId: pol.versionId,
      status: 'GENERATED',
      generatedBy: input.actor,
      notes:
        missing.length > 0
          ? `Thiếu tài khoản: ${missing.map((m) => m.employeeCode).join(', ')}`
          : null,
    })
    .returning({ id: bankPaymentBatches.id, batchNo: bankPaymentBatches.batchNo });

  const warnings: string[] = [...file.validation.warnings];
  if (unverified.length > 0) {
    warnings.push(
      `${unverified.length} tài khoản CHƯA đối chiếu với ngân hàng: ` +
        unverified
          .slice(0, 5)
          .map((u) => `${u.employeeCode} (${u.accountNumber})`)
          .join(', ') +
        (unverified.length > 5 ? '…' : ''),
    );
  }
  if (missing.length > 0) {
    warnings.push(
      `${missing.length} nhân viên KHÔNG có trong file vì thiếu tài khoản ngân hàng`,
    );
  }

  return {
    batchId: batch!.id,
    batchNo: batch!.batchNo,
    fileName: file.fileName,
    file,
    missing,
    unverified,
    warnings,
  };
}

/**
 * Kiểm tra lại checksum của một lô đã lưu.
 *
 * Dùng khi kế toán nghi ngờ file trên đĩa đã bị sửa. Trả về khớp/không khớp chứ
 * không tự "sửa lại cho khớp" — file đã gửi ngân hàng là chứng từ, không ai được
 * phép làm cho nó trông đúng.
 */
export async function verifyBatchChecksum(
  db: Db,
  batchId: string,
  content: string,
): Promise<{ ok: boolean; expected: string; actual: string }> {
  const [b] = await db
    .select({ checksum: bankPaymentBatches.checksum })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.id, batchId))
    .limit(1);
  if (!b) throw new PaymentFileError('INVALID_PAYMENT_DATA', `Không tìm thấy lô ${batchId}`);
  const { createHash } = await import('node:crypto');
  const actual = createHash('sha256').update(content, 'utf8').digest('hex');
  return { ok: actual === b.checksum, expected: b.checksum, actual };
}

/** Đổi trạng thái lô. Chỉ cho phép các bước chuyển hợp lệ. */
export async function updateBatchStatus(
  db: Db,
  batchId: string,
  status: 'SENT' | 'RETURNED' | 'VOID',
  opts: { returnedCount?: number; notes?: string },
): Promise<void> {
  const VALID: Record<string, string[]> = {
    GENERATED: ['SENT', 'VOID'],
    SENT: ['RETURNED', 'VOID'],
    RETURNED: ['VOID'],
    VOID: [],
  };
  const [b] = await db
    .select({ status: bankPaymentBatches.status })
    .from(bankPaymentBatches)
    .where(eq(bankPaymentBatches.id, batchId))
    .limit(1);
  if (!b) throw new PaymentFileError('INVALID_PAYMENT_DATA', `Không tìm thấy lô ${batchId}`);
  if (!VALID[b.status]?.includes(status)) {
    throw new PaymentFileError(
      'INVALID_PAYMENT_DATA',
      `Không thể chuyển lô từ ${b.status} sang ${status}`,
    );
  }
  await db
    .update(bankPaymentBatches)
    .set({
      status,
      returnedCount: opts.returnedCount ?? 0,
      notes: opts.notes ?? null,
    })
    .where(eq(bankPaymentBatches.id, batchId));
}

/**
 * Danh sách nhân viên chưa có tài khoản chính — để giao diện cảnh báo sớm.
 *
 * CHỈ nhân viên còn làm việc. Bản đầu tiên lấy tất cả, nên danh sách đầy những
 * người đã nghỉ từ lâu — một danh sách dài toàn nhiễu thì không ai đọc, và người
 * thật sự đang chờ lương bị chìm trong đó. Đây chính là bài học đã gặp ở chỉ số
 * "cần rà soát" của chấm công.
 */
export async function employeesWithoutAccount(db: Db): Promise<string[]> {
  const all = await db
    .select({ code: employees.employeeCode })
    .from(employees)
    .where(eq(employees.active, true));
  const withAcc = await db
    .select({ code: employeeBankAccounts.employeeCode })
    .from(employeeBankAccounts)
    .where(and(eq(employeeBankAccounts.isPrimary, true), eq(employeeBankAccounts.active, true)));
  const have = new Set(withAcc.map((a) => a.code));
  return all.map((e) => e.code).filter((c) => !have.has(c));
}
