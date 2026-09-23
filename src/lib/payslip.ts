/**
 * ============================================================================
 * DỮ LIỆU PHIẾU LƯƠNG — nối ba engine rồi đưa vào mẫu in
 * ============================================================================
 *
 *   VN_SALARY → VN_BHXH → VN_PIT → mẫu in PRINT
 *
 * Mọi con số đều resolve theo NGÀY CỦA KỲ LƯƠNG. Đổi kỳ là đổi luật áp dụng,
 * và phiếu lương cũ vẫn tái hiện đúng con số đã tính — vì phiên bản chính sách
 * cũ vẫn còn trong DB với khoảng hiệu lực của nó.
 */

import { eq } from 'drizzle-orm';
import { getDb } from '@/db/client';
import { employees, payslips, payRuns } from '@/db/schema';
import { resolvePolicy } from '@/policy/registry';
import { vnSalaryParamsSchema } from '@/policy/salary-params';
import { vnSiParamsSchema } from '@/policy/si-params';
import { vnPitParamsSchema } from '@/policy/tax-params';
import { printParamsSchema, type PrintParams } from '@/policy/print-params';
import { calculateSalary } from '@/engine/salary';
import { calculateSocialInsurance, type WageRegion } from '@/engine/si';
import { calculateTaxableIncome, calculateProgressivePit } from '@/engine/pit';
import type { PrintData } from '@/engine/print';

export interface PayslipInput {
  employeeName: string;
  department: string;
  /** Kỳ lương, vd. '2026-09-30'. Dùng để resolve chính sách. */
  periodEnd: string;
  wageRegion: WageRegion;
  trainedWorker?: boolean;
  dependents: number;
  /** Biến đầu vào cho công thức lương. */
  variables: Record<string, number>;
}

export interface PayslipRenderInput {
  template: PrintParams;
  /** Phiên bản mẫu in đã dùng — để ghi provenance lên tài liệu. */
  templateVersion: number;
  data: PrintData;
  numericInputs: Record<string, number>;
  /** Để hiển thị / log: các phiên bản chính sách đã áp dụng. */
  applied: { salary: string; si: string; pit: string };
}

export async function buildPayslipPrintData(
  input: PayslipInput,
  templateCode: string,
): Promise<PayslipRenderInput> {
  const db = getDb();
  const at = input.periodEnd;

  // --- 1. Lương ------------------------------------------------------------
  const salaryPolicy = await resolvePolicy('VN_SALARY', at, vnSalaryParamsSchema, db);
  const sal = calculateSalary({ variables: input.variables }, salaryPolicy.params);

  // --- 2. Bảo hiểm — căn cứ là tổng thành phần có cờ inInsuranceBase --------
  const siPolicy = await resolvePolicy('VN_BHXH', at, vnSiParamsSchema, db);
  const si = calculateSocialInsurance(
    {
      contributionSalary: sal.insuranceBaseSalary,
      wageRegion: input.wageRegion,
      trainedWorker: input.trainedWorker ?? false,
    },
    siPolicy.params,
  );

  // --- 3. Thuế — thu nhập chịu thuế là tổng thành phần có cờ taxable -------
  const pitPolicy = await resolvePolicy('VN_PIT', at, vnPitParamsSchema, db);
  const ti = calculateTaxableIncome(
    {
      grossIncome: sal.taxableIncome,
      exemptIncome: 0,
      employeeSocialInsurance: si.employee.total,
      voluntaryPensionContribution: 0,
      dependentCount: input.dependents,
    },
    pitPolicy.params,
  );
  const pit = calculateProgressivePit(ti.taxableIncome, pitPolicy.params);

  // --- 4. Mẫu in -----------------------------------------------------------
  // resolvePolicy theo mã: mẫu in cũng là chính sách có hiệu lực theo ngày,
  // nên một mẫu cũ vẫn in lại được phiếu lương của kỳ cũ.
  const templatePolicy = await resolvePolicy('PRINT', at, printParamsSchema, db, templateCode);
  if (templatePolicy.params.regimeCode !== templateCode) {
    throw new RangeError(
      `Mẫu in đang hiệu lực tại ${at} là '${templatePolicy.params.regimeCode}', ` +
        `không phải '${templateCode}'.`,
    );
  }

  // Khấu trừ = tổng các thành phần âm, lấy giá trị dương để in ra "(số tiền)"
  const advance = -sal.components
    .filter((c) => c.amount < 0)
    .reduce((sum, c) => sum + c.amount, 0);

  return {
    template: templatePolicy.params,
    templateVersion: templatePolicy.version,
    numericInputs: {
      gross: sal.earningsTotal,
      siEmployee: si.employee.total,
      pit: pit.pit,
      advance,
      dependents: input.dependents,
      workedDays: input.variables.workedDays ?? 0,
      standardDays: input.variables.standardDays ?? 0,
    },
    data: {
      TEN_NV: input.employeeName,
      KY_LUONG: input.periodEnd.slice(0, 7).split('-').reverse().join('/'),
      BO_PHAN: input.department,
      NGAY_IN: new Date().toISOString().slice(0, 10),
      standardDays: input.variables.standardDays ?? 0,
      dependents: input.dependents,
    },
    applied: {
      salary: `${salaryPolicy.params.regimeCode} v${salaryPolicy.version}`,
      si: `${siPolicy.params.regimeCode} v${siPolicy.version}`,
      pit: `${pitPolicy.params.regimeCode} v${pitPolicy.version}`,
    },
  };
}

/**
 * ============================================================================
 * IN TỪ SỐ LIỆU ĐÃ LƯU — engine KHÔNG chạy lại
 * ============================================================================
 *
 * Khi in một phiếu lương đã lập, không được tính lại. Chính sách trong database
 * có thể đã đổi kể từ khi kỳ này được tính; tính lại sẽ cho ra con số KHÁC với
 * con số đã trả cho người lao động — đúng là thứ mà một bảng lương tuyệt đối
 * không được phép làm.
 *
 * Vậy nên hàm này đọc thẳng `payslips.components` và các cột đã lưu. Engine chỉ
 * còn được dùng cho những trường có biểu thức (`expr`) — và đó là phép cộng
 * thuần tuý trên các con số đã chốt, không phải một lần tính lương mới.
 */
export async function loadPayslipPrintData(
  payslipId: string,
  templateCode = 'PHIEU_LUONG',
): Promise<PayslipRenderInput> {
  const db = getDb();
  const [row] = await db
    .select({ s: payslips, e: employees })
    .from(payslips)
    .innerJoin(employees, eq(payslips.employeeId, employees.id))
    .where(eq(payslips.id, payslipId))
    .limit(1);
  if (!row) throw new RangeError(`Không tìm thấy phiếu lương ${payslipId}`);
  const { s: slip, e: emp } = row;

  const [run] = await db.select().from(payRuns).where(eq(payRuns.id, slip.payRunId)).limit(1);
  if (!run) throw new RangeError(`Không tìm thấy kỳ lương ${slip.payRunId}`);

  // Mẫu in resolve theo NGÀY CUỐI KỲ chứ không phải hôm nay: một mẫu đã bị
  // thay thế sau đó vẫn phải in lại được phiếu lương của kỳ cũ.
  const periodEnd = `${run.periodYear}-${String(run.periodMonth).padStart(2, '0')}-${String(
    new Date(run.periodYear, run.periodMonth, 0).getDate(),
  ).padStart(2, '0')}`;
  const templatePolicy = await resolvePolicy(
    'PRINT',
    periodEnd,
    printParamsSchema,
    db,
    templateCode,
  );
  if (templatePolicy.params.regimeCode !== templateCode) {
    throw new RangeError(
      `Mẫu in hiệu lực tại ${periodEnd} là '${templatePolicy.params.regimeCode}', ` +
        `không phải '${templateCode}'.`,
    );
  }

  const v = slip.variables as Record<string, number>;
  const snap = slip.policySnapshot as Record<string, { code?: string; version?: number }>;
  const named = (k: string) => `${snap[k]?.code ?? '?'} v${snap[k]?.version ?? '?'}`;

  return {
    template: templatePolicy.params,
    templateVersion: templatePolicy.version,
    numericInputs: {
      gross: slip.earningsTotal,
      siEmployee: slip.siEmployee,
      pit: slip.pit,
      advance: Math.abs(slip.deductionsTotal),
      dependents: emp.dependents,
      workedDays: v.workedDays ?? 0,
      standardDays: v.standardDays ?? 0,
    },
    data: {
      TEN_NV: slip.fullName,
      MA_NV: slip.employeeCode,
      KY_LUONG: `${String(run.periodMonth).padStart(2, '0')}/${run.periodYear}`,
      BO_PHAN: emp.department,
      MA_SO_THUE: emp.taxCode ?? '',
      NGAY_IN: new Date().toISOString().slice(0, 10),
      standardDays: v.standardDays ?? 0,
      dependents: emp.dependents,
      // Bảng thành phần đã lưu — in đúng như lúc lập kỳ, không tính lại.
      THANH_PHAN: slip.components,
    },
    applied: {
      salary: named('VN_SALARY'),
      si: named('VN_BHXH'),
      pit: named('VN_PIT'),
    },
  };
}

/** Dữ liệu mẫu cho trang demo — một nhân viên có thật về mặt nghiệp vụ. */
export const SAMPLE_PAYSLIP: PayslipInput = {
  employeeName: 'Nguyễn Văn An',
  department: 'Kỹ thuật',
  periodEnd: '2026-09-30',
  wageRegion: 'I',
  trainedWorker: true,
  dependents: 1,
  variables: {
    baseSalary: 25_000_000,
    workedDays: 22,
    standardDays: 22,
    kpiScore: 85,
    otNormalHours: 10,
    otWeekendHours: 4,
    otHolidayHours: 0,
    hourlyRate: 120_000,
    mealDays: 22,
    lateCount: 5,
    advanceAmount: 2_000_000,
  },
};
